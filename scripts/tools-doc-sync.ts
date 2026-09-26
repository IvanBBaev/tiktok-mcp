/**
 * tools-doc-sync (TESTING.md § Sync gates and repo meta).
 *
 * `docs/tool-manifest.json` is generated: the byte-exact wire surface of
 * `tools/list`, and `manifest-snapshot` fails the moment it stops matching
 * `src/tools/`. `docs/TOOLS.md` restates that same surface by hand — the § 1
 * glance table, and per tool a **Package** line, a **Scopes** line, the four
 * annotation hints, the description quoted as "(normative)", and one table row
 * per input field — because a JSON dump is not a specification anybody reviews.
 * Two statements of one truth, and until this gate only one of them was
 * checked: a one-word edit to a `.describe()` regenerated the manifest and left
 * the normative document asserting the old text. That is worse than having no
 * document. The manifest is what the model reads, TOOLS.md is what the reviewer
 * reads, and a disagreement between them is invisible in both.
 *
 * The comparison is against the **committed manifest**, not against
 * `describeAllTools()`. Deliberate: the manifest ⇄ code edge already has an
 * owner, and borrowing it here would both fail twice for one cause and — the
 * real hazard — let a doc that agrees with a *stale* manifest read as agreeing
 * with the code. One edge each: doc ⇄ manifest ⇄ code.
 *
 * What is checked, per tool:
 *
 *  - **bijection**, in both directions. A manifest tool with no `### 3.N`
 *    section is undocumented; a section naming a tool the manifest does not
 *    have is a section describing something that no longer exists, which reads
 *    exactly like a specification and is a lie. Two sections for one tool is
 *    the same failure wearing a copy-paste mask;
 *  - **order and numbering**: the n-th section is `3.<n>` and names the n-th
 *    manifest tool. The document cross-references itself by number ("as § 3.8",
 *    "rows as § 3.10") and § 1's table is numbered in the same order, so a
 *    section inserted out of order silently re-points every reference to it;
 *  - the **Package** and **Scopes** lines against `package` / `scopes` /
 *    `scopesAnyOf`. Only the *leading* scope claim is read — everything after
 *    the first `;`, `(` or sentence stop is prose about scopes that are not
 *    required (§ 3.2 names `user.info.profile` and `user.info.stats` as
 *    field-level upgrades), and a scan that swallowed those would report a
 *    correct section as drifted, which is how a gate gets turned off;
 *  - the four **annotation hints**, from the Package bullet only. The
 *    justification prose that follows them is an argument, not a value;
 *  - the normative **description**, paragraph by paragraph. Whitespace inside a
 *    paragraph is collapsed because the doc hard-wraps at 88 columns and the
 *    manifest string does not, but paragraph breaks are compared, so a dropped
 *    blank `>` line still fails;
 *  - the **input schema**: the set *and order* of `Field` cells against the
 *    schema's properties, and — for each row — the `Req` cell against the
 *    `required` array, the `Type` cell, and the `.describe()` cell against the
 *    property's `description`.
 *
 * Two schema-table subtleties are worth stating, because both look like bugs
 * until they are read as decisions. `Req` is not a boolean column: it also
 * carries handler-level conditions (`iff \`source: "file"\``, `for execution`)
 * for fields the wire schema cannot mark required. The gate therefore reads
 * exactly `yes` as "in `required`" and every other spelling as "not in
 * `required`" — which is what those cells mean — and never tries to verify the
 * condition itself. And a `.describe()` cell comes in three forms: a quoted
 * string, `(common…)` deferring to § 2.2's normative `account` text, and
 * `(as § 3.N)` deferring to another section's row for the same field. All three
 * are resolved and compared; a *fourth* form is reported rather than skipped,
 * because a cell shape the gate cannot read is a cell nothing checks.
 *
 * Deliberately NOT checked, so this gate's silence is not read as more than it
 * is:
 *
 *  - the `Constraints` column. It is prose about behavior — "clamped locally
 *    and noted in the result", "1 byte … 4 GiB" — and most of it is enforced in
 *    handlers, not in the schema. There is nothing in the manifest to compare
 *    it to;
 *  - the `Type` column beyond `string`, `boolean`, `integer` and `string[]`.
 *    Unions are spelled inline three different ways (`` `"file" \| "url"` ``,
 *    `enum \`A \| B\``, bare `enum`); normalizing them would be guesswork, and
 *    a guess that usually works is the worst kind of check;
 *  - the reverse direction of a **prose-form** input schema. Three sections
 *    (§ 3.5, § 3.9, § 3.11) state their schema as a sentence rather than a
 *    table, so the gate can only assert that every property is named there. The
 *    sentence's other code spans are values, section references and field names
 *    of *other* payloads (`false`, `SEND_TO_USER_INBOX`, `post_info`), and no
 *    filter admits `file_path` while rejecting `false`. A field deleted from
 *    such a section's sentence is caught; a field named there that the schema
 *    dropped is not;
 *  - everything else in a section — Output, Errors, Hints, wait semantics,
 *    preview shapes. Those are contracts the manifest does not carry; they are
 *    pinned by the test suite, not by a snapshot;
 *  - `annotations.title`, which the doc does not restate anywhere;
 *  - whether any of the normative prose is *correct*. This gate proves the two
 *    documents say the same thing, never that the thing is true.
 *
 * Check-only, and the one gate here where that is a judgement rather than a
 * limitation: the difference could always be repaired by overwriting the doc
 * from the manifest, and that is precisely the wrong move. TOOLS.md is a
 * ratified spec — a disagreement is either a code change that skipped its
 * document or a document stating an intent the code never grew, and a script
 * cannot tell those apart. It reports both texts and lets a human decide which
 * one is wrong.
 *
 * Usage: `node build/scripts/tools-doc-sync.js`
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { asRecord, asString, REPO_ROOT } from './lib/repo.js';

const DOC = 'docs/TOOLS.md';
const MANIFEST = 'docs/tool-manifest.json';

/** The annotation hints TOOLS.md § 1 requires on every tool. */
const HINTS: readonly string[] = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
];

/** A `### 3.N \`tiktok_x\`` heading — the only thing that opens a tool section. */
const SECTION = /^### (3\.\d+) `(tiktok_[a-z_]+)`\s*$/u;

/** The input-schema table's header row, matched to find the table at all. */
const SCHEMA_HEADER = /^\s*\|\s*Field\s*\|\s*Type\s*\|\s*Req\s*\|/u;

/** § 1's glance table header. */
const GLANCE_HEADER = /^\s*\|\s*#\s*\|\s*Tool\s*\|\s*Package\s*\|/u;

/** A scope id as the docs spell one: `video.publish`, `user.info.basic`. */
const SCOPE_ID = /^[a-z]+(?:\.[a-z]+)+$/u;

/** The spellings § 1 and § 3 use for "this tool requires no scope". */
const NO_SCOPES = /^(?:none|—|-)$/u;

// ---------------------------------------------------------------------------
// The manifest, read as data rather than trusted as a shape
// ---------------------------------------------------------------------------

export interface ManifestProperty {
  readonly type?: string;
  readonly items?: { readonly type?: string };
  readonly description?: string;
}

export interface ManifestTool {
  readonly name: string;
  readonly package: string;
  readonly scopes: readonly string[];
  readonly scopesAnyOf?: readonly string[];
  readonly description: string;
  readonly annotations: ReadonlyMap<string, boolean>;
  readonly properties: ReadonlyMap<string, ManifestProperty>;
  readonly required: readonly string[];
}

function asStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value as readonly unknown[]) {
    const text = asString(item);
    if (text === undefined) return undefined;
    out.push(text);
  }
  return out;
}

function parseProperty(value: unknown): ManifestProperty {
  const record = asRecord(value) ?? {};
  const items = asRecord(record['items']);
  return {
    type: asString(record['type']),
    ...(items === undefined ? {} : { items: { type: asString(items['type']) } }),
    description: asString(record['description']),
  };
}

function parseTool(value: unknown): ManifestTool | undefined {
  const record = asRecord(value);
  const schema = asRecord(record?.['inputSchema']);
  if (record === undefined || schema === undefined) return undefined;
  const name = asString(record['name']);
  const pack = asString(record['package']);
  const description = asString(record['description']);
  const scopes = asStringList(record['scopes']);
  if (
    name === undefined ||
    pack === undefined ||
    description === undefined ||
    scopes === undefined
  ) {
    return undefined;
  }
  const annotations = new Map<string, boolean>();
  for (const [key, hint] of Object.entries(asRecord(record['annotations']) ?? {})) {
    if (typeof hint === 'boolean') annotations.set(key, hint);
  }
  const properties = new Map<string, ManifestProperty>();
  for (const [key, property] of Object.entries(asRecord(schema['properties']) ?? {})) {
    properties.set(key, parseProperty(property));
  }
  const anyOf = asStringList(record['scopesAnyOf']);
  return {
    name,
    package: pack,
    scopes,
    ...(anyOf === undefined ? {} : { scopesAnyOf: anyOf }),
    description,
    annotations,
    properties,
    required: asStringList(schema['required']) ?? [],
  };
}

/** The manifest's tools, or `undefined` when the file is not the shape it claims. */
export function parseManifest(json: string): readonly ManifestTool[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  const tools = asRecord(parsed)?.['tools'];
  if (!Array.isArray(tools)) return undefined;
  const out: ManifestTool[] = [];
  for (const entry of tools as readonly unknown[]) {
    const tool = parseTool(entry);
    if (tool === undefined) return undefined;
    out.push(tool);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Markdown, read the way this document is actually written
// ---------------------------------------------------------------------------

/** Whitespace-insensitive text: the doc hard-wraps, the manifest string does not. */
export function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Paragraph structure kept, wrapping thrown away. */
function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/u)
    .map(collapse)
    .filter((para) => para !== '')
    .join('\n\n');
}

/** `\|` and `\"` are markdown table/quote escapes, not part of the string. */
function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_[\]()#+\-.!|"<>])/gu, '$1');
}

/**
 * The text with every code span blanked to same-length filler.
 *
 * Scope ids and defaults are full of `.` and the describe cells are full of
 * `;`, so a delimiter search has to be blind to anything inside backticks.
 */
function maskCode(text: string): string {
  return text.replace(/`[^`]*`/gu, (span) => ' '.repeat(span.length));
}

/** The code spans of `text`, in order, unescaped. */
function codeSpans(text: string): readonly string[] {
  return [...text.matchAll(/`([^`]*)`/gu)].map((match) =>
    unescapeMarkdown(match[1] ?? ''),
  );
}

/** A markdown table row's cells, honouring `\|` inside a cell. */
export function rowCells(row: string): readonly string[] {
  const trimmed = row
    .trim()
    .replace(/^\|/u, '')
    .replace(/(?<!\\)\|$/u, '');
  return trimmed.split(/(?<!\\)\|/u).map((cell) => cell.trim());
}

/** Bold markers stripped: § 1 emphasises the values that differ from the norm. */
function unbold(cell: string): string {
  return cell.replace(/\*\*/gu, '').trim();
}

/**
 * A cell's value, whether or not it is set as code.
 *
 * § 1 backticks tool names and scope ids but not package names, and § 3
 * backticks all three. Both spellings mean the same thing, so neither is worth
 * a failure — and a gate that failed on formatting would train people to read
 * its output as noise.
 */
function cellText(cell: string): string {
  return codeSpans(cell)[0] ?? unbold(cell);
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export interface ScopeClaim {
  /** The scope ids the leading claim names, in the order it names them. */
  readonly scopes: readonly string[];
  /** True when the claim spells them as alternatives — "A **or** B". */
  readonly anyOf: boolean;
  /** The leading claim verbatim, for the failure text. */
  readonly text: string;
}

export interface DocField {
  readonly name: string;
  /** The `Type` cell verbatim. */
  readonly type: string;
  /** The `Req` cell verbatim — not a boolean; see the header docblock. */
  readonly req: string;
  /** The `.describe()` cell verbatim, before resolution. */
  readonly describe: string;
}

export type DocSchema =
  | { readonly form: 'table'; readonly fields: readonly DocField[] }
  | { readonly form: 'prose'; readonly named: ReadonlySet<string> };

export interface DocSection {
  /** The `3.N` the heading carries. */
  readonly number: string;
  readonly tool: string;
  readonly package: string | undefined;
  /** Hint name → value, in the order the Package bullet states them. */
  readonly annotations: readonly (readonly [string, boolean])[];
  readonly scopes: ScopeClaim | undefined;
  /** The normative blockquote, wrapping collapsed, paragraph breaks kept. */
  readonly description: string | undefined;
  readonly schema: DocSchema | undefined;
}

export interface GlanceRow {
  readonly tool: string;
  readonly package: string;
  readonly annotations: readonly (readonly [string, boolean])[];
  readonly scopes: ScopeClaim;
}

export interface DocSurface {
  readonly sections: readonly DocSection[];
  readonly glance: readonly GlanceRow[] | undefined;
  /** The "**N tools, M packages.**" headline of § 1. */
  readonly headline: { readonly tools: number; readonly packages: number } | undefined;
  /** § 2.2's normative `account` describe, which every `(common)` cell defers to. */
  readonly commonAccount: string | undefined;
}

/**
 * The leading scope claim of a line: everything before the first `;`, `(` or
 * sentence stop that is not inside a code span.
 */
export function parseScopeClaim(line: string): ScopeClaim {
  const body = collapse(line.replace(/^-?\s*\*\*Scopes:\*\*/u, ''));
  const cut = maskCode(body).search(/[;.(]/u);
  const text = (cut < 0 ? body : body.slice(0, cut)).trim();
  const scopes = codeSpans(text).filter((span) => SCOPE_ID.test(span));
  return { scopes, anyOf: /\bor\b/u.test(maskCode(text)), text };
}

/** The lines of a `- **Label:**` bullet, up to the next top-level bullet. */
function bulletBlock(lines: readonly string[], start: number): readonly string[] {
  const block: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (i > start && /^- \*\*/u.test(line)) break;
    block.push(line);
  }
  return block;
}

/** The blockquote under the "**Description** (normative)" bullet. */
function parseDescription(lines: readonly string[]): string | undefined {
  const start = lines.findIndex((line) => /\*\*Description\*\* \(normative/u.test(line));
  if (start < 0) return undefined;
  const quoted: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const quote = /^\s*>\s?(.*)$/u.exec(line);
    if (quote === null) {
      if (quoted.length === 0 && line.trim() === '') continue;
      break;
    }
    quoted.push(quote[1] ?? '');
  }
  return quoted.length === 0 ? undefined : paragraphs(quoted.join('\n'));
}

/** Rows of the table whose header starts at `header`. */
function tableRows(
  lines: readonly string[],
  header: number,
): readonly (readonly string[])[] {
  const rows: (readonly string[])[] = [];
  for (let i = header + 2; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!/^\s*\|/u.test(line)) break;
    rows.push(rowCells(line));
  }
  return rows;
}

/** The input schema as the section states it: a table, or a sentence. */
function parseSchema(lines: readonly string[]): DocSchema | undefined {
  const start = lines.findIndex((line) => /^- \*\*Input schema/u.test(line));
  if (start < 0) return undefined;
  const block = bulletBlock(lines, start);
  const header = block.findIndex((line) => SCHEMA_HEADER.test(line));
  if (header < 0) {
    return { form: 'prose', named: new Set(codeSpans(block.join(' '))) };
  }
  const fields = tableRows(block, header).map((cells) => ({
    name: cellText(cells[0] ?? ''),
    type: cells[1] ?? '',
    req: cells[2] ?? '',
    describe: cells[4] ?? '',
  }));
  return { form: 'table', fields };
}

/** Every `### 3.N \`tiktok_*\`` section, in document order. */
export function parseSections(markdown: string): readonly DocSection[] {
  const lines = markdown.split('\n');
  const sections: DocSection[] = [];
  let current: { number: string; tool: string; body: string[] } | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    const body = current.body;
    const packageLine = body.findIndex((line) => /^- \*\*Package:\*\*/u.test(line));
    const packageBlock = packageLine < 0 ? '' : bulletBlock(body, packageLine).join(' ');
    const scopeLine = body.findIndex((line) => /^- \*\*Scopes:\*\*/u.test(line));
    sections.push({
      number: current.number,
      tool: current.tool,
      package: packageLine < 0 ? undefined : codeSpans(packageBlock)[0],
      annotations: [...packageBlock.matchAll(/`(\w+Hint):\s*(true|false)`/gu)].map(
        (match) => [match[1] ?? '', match[2] === 'true'] as const,
      ),
      scopes:
        scopeLine < 0
          ? undefined
          : parseScopeClaim(bulletBlock(body, scopeLine).join(' ')),
      description: parseDescription(body),
      schema: parseSchema(body),
    });
    current = undefined;
  };
  for (const line of lines) {
    const heading = SECTION.exec(line);
    if (heading !== null) {
      flush();
      current = { number: heading[1] ?? '', tool: heading[2] ?? '', body: [] };
      continue;
    }
    if (/^#{1,3} /u.test(line)) flush();
    current?.body.push(line);
  }
  flush();
  return sections;
}

/** § 1's "Surface at a glance" table, or `undefined` when it is not there. */
export function parseGlance(markdown: string): readonly GlanceRow[] | undefined {
  const lines = markdown.split('\n');
  const header = lines.findIndex((line) => GLANCE_HEADER.test(line));
  if (header < 0) return undefined;
  const columns = rowCells(lines[header] ?? '').slice(3, 7);
  return tableRows(lines, header).map((cells) => ({
    tool: cellText(cells[1] ?? ''),
    package: cellText(cells[2] ?? ''),
    annotations: columns.map(
      (name, index) => [name, unbold(cells[index + 3] ?? '') === 'true'] as const,
    ),
    scopes: parseScopeClaim(cells[7] ?? ''),
  }));
}

/** Everything this gate reads out of TOOLS.md. */
export function parseDoc(markdown: string): DocSurface {
  const headline = /\*\*(\d+) tools?, (\d+) packages?\.\*\*/u.exec(markdown);
  const common = /`\.describe\(\)` \(normative\):\s*\*"([^"]*)"\*/su.exec(markdown);
  return {
    sections: parseSections(markdown),
    glance: parseGlance(markdown),
    headline:
      headline === null
        ? undefined
        : { tools: Number(headline[1]), packages: Number(headline[2]) },
    commonAccount: common === null ? undefined : collapse(common[1] ?? ''),
  };
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

type Resolved =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'unreadable'; readonly reason: string };

const QUOTED = /^"((?:[^"\\]|\\.)*)"(?:\s*\([^)]*\))?$/su;
const COMMON = /^\(common(?:,[^)]*)?\)$/u;
const AS_SECTION = /^\(as § (3\.\d+)\)$/u;

/**
 * The text a `.describe()` cell claims, following one cross-reference hop at a
 * time until a quoted string is reached.
 */
function resolveDescribe(
  cell: string,
  field: string,
  doc: DocSurface,
  seen: ReadonlySet<string> = new Set(),
): Resolved {
  const quoted = QUOTED.exec(cell);
  if (quoted !== null) {
    return { kind: 'text', text: collapse(unescapeMarkdown(quoted[1] ?? '')) };
  }
  if (COMMON.test(cell)) {
    return doc.commonAccount === undefined
      ? { kind: 'unreadable', reason: '§ 2.2 states no normative `account` describe' }
      : { kind: 'text', text: doc.commonAccount };
  }
  const reference = AS_SECTION.exec(cell);
  if (reference === null) {
    return {
      kind: 'unreadable',
      reason:
        'the cell is neither a quoted string, nor `(common)`, nor `(as § 3.N)` — ' +
        'the three forms this gate can follow',
    };
  }
  const number = reference[1] ?? '';
  if (seen.has(number)) {
    return { kind: 'unreadable', reason: `the "(as § …)" references form a cycle` };
  }
  const target = doc.sections.find((section) => section.number === number);
  const row =
    target?.schema?.form === 'table'
      ? target.schema.fields.find((entry) => entry.name === field)
      : undefined;
  if (row === undefined) {
    return {
      kind: 'unreadable',
      reason: `§ ${number} has no \`${field}\` row to defer to`,
    };
  }
  return resolveDescribe(row.describe, field, doc, new Set([...seen, number]));
}

/** The JSON-Schema shape a `Type` cell claims, for the spellings worth reading. */
function typeMatches(cell: string, property: ManifestProperty): boolean | undefined {
  switch (unbold(cell)) {
    case 'string':
    case 'boolean':
    case 'integer':
      return property.type === unbold(cell);
    case 'string[]':
      return property.type === 'array' && property.items?.type === 'string';
    default:
      return undefined;
  }
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, i) => item === right[i]);
}

function quoteList(items: readonly string[]): string {
  return items.length === 0 ? 'none' : items.map((item) => `\`${item}\``).join(', ');
}

/** One problem line per disagreement, in document order. */
function checkScopes(where: string, claim: ScopeClaim, tool: ManifestTool): string[] {
  const anyOf = tool.scopesAnyOf ?? [];
  const expected = anyOf.length > 0 ? anyOf : tool.scopes;
  const problems: string[] = [];
  if (claim.scopes.length === 0 && !NO_SCOPES.test(claim.text)) {
    problems.push(
      `${where}: the scope claim "${claim.text}" names no scope and does not say "none"`,
    );
    return problems;
  }
  if (!sameList(claim.scopes, expected)) {
    problems.push(
      `${where}: scopes are ${quoteList([...claim.scopes])} in the doc, ` +
        `${quoteList([...expected])} in the manifest`,
    );
  }
  if (claim.anyOf !== anyOf.length > 0) {
    problems.push(
      claim.anyOf
        ? `${where}: the doc offers the scopes as alternatives ("or"), the manifest requires them all`
        : `${where}: the manifest declares scopesAnyOf, the doc states the scopes as required`,
    );
  }
  return problems;
}

function checkAnnotations(
  where: string,
  stated: readonly (readonly [string, boolean])[],
  tool: ManifestTool,
): string[] {
  const problems: string[] = [];
  const claimed = new Map<string, boolean>();
  for (const [hint, value] of stated) {
    if (claimed.has(hint) && claimed.get(hint) !== value) {
      problems.push(`${where}: \`${hint}\` is stated twice, with different values`);
    }
    claimed.set(hint, value);
  }
  for (const hint of HINTS) {
    const doc = claimed.get(hint);
    const manifest = tool.annotations.get(hint);
    if (doc === manifest) continue;
    problems.push(
      `${where}: \`${hint}\` is ${doc === undefined ? 'missing' : String(doc)} in the doc, ` +
        `${manifest === undefined ? 'missing' : String(manifest)} in the manifest`,
    );
  }
  return problems;
}

function checkSchema(
  where: string,
  schema: DocSchema,
  tool: ManifestTool,
  doc: DocSurface,
): string[] {
  const properties = [...tool.properties.keys()];
  const problems: string[] = [];
  if (schema.form === 'prose') {
    const missing = properties.filter((name) => !schema.named.has(name));
    if (missing.length > 0) {
      problems.push(
        `${where}: the input-schema sentence never names ${quoteList(missing)} — ` +
          'a prose schema is only checked in this direction (see the gate docblock)',
      );
    }
    return problems;
  }
  const fields = schema.fields.map((field) => field.name);
  if (!sameList(fields, properties)) {
    problems.push(
      `${where}: the input-schema table lists ${quoteList(fields)}, ` +
        `the schema has ${quoteList(properties)} (order included)`,
    );
  }
  const required = schema.fields
    .filter((field) => field.req === 'yes')
    .map((field) => field.name);
  if (!sameList([...required].sort(), [...tool.required].sort())) {
    problems.push(
      `${where}: the table marks ${quoteList(required)} required, ` +
        `the schema requires ${quoteList([...tool.required])} ` +
        '(a `Req` cell other than `yes` reads as not-required)',
    );
  }
  for (const field of schema.fields) {
    const property = tool.properties.get(field.name);
    if (property === undefined) continue;
    if (typeMatches(field.type, property) === false) {
      problems.push(
        `${where}: \`${field.name}\` is \`${unbold(field.type)}\` in the table, ` +
          `\`${property.type ?? 'untyped'}\` in the schema`,
      );
    }
    const resolved = resolveDescribe(field.describe, field.name, doc);
    if (resolved.kind === 'unreadable') {
      problems.push(
        `${where}: the \`.describe()\` cell for \`${field.name}\` cannot be read — ` +
          resolved.reason,
      );
      continue;
    }
    const actual = collapse(property.description ?? '');
    if (resolved.text !== actual) {
      problems.push(
        `${where}: the \`.describe()\` of \`${field.name}\` disagrees\n` +
          `      doc:      ${resolved.text}\n` +
          `      manifest: ${actual}`,
      );
    }
  }
  return problems;
}

function checkSection(
  section: DocSection,
  tool: ManifestTool,
  doc: DocSurface,
): string[] {
  const where = `§ ${section.number} ${tool.name}`;
  const problems: string[] = [];
  if (section.package !== tool.package) {
    problems.push(
      `${where}: package is \`${section.package ?? 'missing'}\` in the doc, ` +
        `\`${tool.package}\` in the manifest`,
    );
  }
  if (section.scopes === undefined) {
    problems.push(`${where}: no "- **Scopes:**" line`);
  } else {
    problems.push(...checkScopes(where, section.scopes, tool));
  }
  problems.push(...checkAnnotations(where, section.annotations, tool));
  const described = paragraphs(tool.description);
  if (section.description === undefined) {
    problems.push(`${where}: no "**Description** (normative)" blockquote`);
  } else if (section.description !== described) {
    problems.push(
      `${where}: the normative description disagrees with the manifest\n` +
        `      doc:      ${section.description.replace(/\n\n/gu, ' ⏎⏎ ')}\n` +
        `      manifest: ${described.replace(/\n\n/gu, ' ⏎⏎ ')}`,
    );
  }
  if (section.schema === undefined) {
    problems.push(`${where}: no "- **Input schema**" bullet`);
  } else {
    problems.push(...checkSchema(where, section.schema, tool, doc));
  }
  return problems;
}

function checkGlance(doc: DocSurface, tools: readonly ManifestTool[]): string[] {
  const problems: string[] = [];
  const packages = new Set(tools.map((tool) => tool.package));
  if (doc.headline === undefined) {
    problems.push('§ 1: no "**N tools, M packages.**" headline');
  } else if (
    doc.headline.tools !== tools.length ||
    doc.headline.packages !== packages.size
  ) {
    problems.push(
      `§ 1: the headline claims ${String(doc.headline.tools)} tools in ` +
        `${String(doc.headline.packages)} packages; the manifest has ` +
        `${String(tools.length)} in ${String(packages.size)}`,
    );
  }
  if (doc.glance === undefined) {
    problems.push('§ 1: no "Surface at a glance" table');
    return problems;
  }
  const listed = doc.glance.map((row) => row.tool);
  if (
    !sameList(
      listed,
      tools.map((tool) => tool.name),
    )
  ) {
    problems.push(
      `§ 1: the glance table lists ${quoteList(listed)}, ` +
        `the manifest has ${quoteList(tools.map((tool) => tool.name))} (order included)`,
    );
    return problems;
  }
  for (const [index, row] of doc.glance.entries()) {
    const tool = tools[index];
    if (tool === undefined) continue;
    const where = `§ 1 ${tool.name}`;
    if (row.package !== tool.package) {
      problems.push(
        `${where}: package is \`${row.package}\` in the glance table, ` +
          `\`${tool.package}\` in the manifest`,
      );
    }
    problems.push(...checkAnnotations(where, row.annotations, tool));
    problems.push(...checkScopes(where, row.scopes, tool));
  }
  return problems;
}

export interface ToolsDocInputs {
  readonly tools: readonly ManifestTool[];
  readonly doc: DocSurface;
}

/** Every disagreement between TOOLS.md and the manifest, in document order. */
export function checkToolsDoc(inputs: ToolsDocInputs): string[] {
  const { tools, doc } = inputs;
  const problems: string[] = [];
  const byTool = new Map<string, DocSection[]>();
  for (const section of doc.sections) {
    byTool.set(section.tool, [...(byTool.get(section.tool) ?? []), section]);
  }
  const known = new Set(tools.map((tool) => tool.name));

  for (const tool of tools) {
    if (byTool.has(tool.name)) continue;
    problems.push(
      `${tool.name} is in ${MANIFEST} but ${DOC} § 3 documents no such tool — ` +
        'a tool an agent can call and a reviewer cannot read',
    );
  }
  for (const [name, sections] of byTool) {
    if (!known.has(name)) {
      problems.push(
        `§ ${sections[0]?.number ?? '3.?'} documents \`${name}\`, which ${MANIFEST} ` +
          'does not have — a section describing a tool that no longer exists',
      );
    }
    if (sections.length > 1) {
      problems.push(
        `${name} has ${String(sections.length)} sections ` +
          `(${sections.map((section) => `§ ${section.number}`).join(', ')})`,
      );
    }
  }
  if (problems.length > 0) return problems;

  for (const [index, tool] of tools.entries()) {
    const section = doc.sections[index];
    const expected = `3.${String(index + 1)}`;
    if (section === undefined) continue;
    if (section.tool !== tool.name || section.number !== expected) {
      problems.push(
        `§ ${section.number} \`${section.tool}\` is section ${String(index + 1)} of ` +
          `${DOC}, where the manifest has \`${tool.name}\` — the document ` +
          `cross-references itself by number, so it must be \`${expected}\``,
      );
    }
  }
  if (problems.length > 0) return problems;

  for (const [index, tool] of tools.entries()) {
    const section = doc.sections[index];
    if (section !== undefined) problems.push(...checkSection(section, tool, doc));
  }
  problems.push(...checkGlance(doc, tools));
  return problems;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Read both documents under `root`.
 *
 * Line endings are normalized because the Windows CI leg is blocking and a
 * checkout there may carry CRLF — a gate that failed on a repo that is
 * perfectly in sync is a gate people learn to ignore.
 */
export async function readToolsDocInputs(
  root: string = REPO_ROOT,
): Promise<ToolsDocInputs | undefined> {
  let markdown: string;
  let json: string;
  try {
    markdown = (await readFile(join(root, DOC), 'utf8')).replace(/\r\n/gu, '\n');
    json = (await readFile(join(root, MANIFEST), 'utf8')).replace(/\r\n/gu, '\n');
  } catch {
    return undefined;
  }
  const tools = parseManifest(json);
  if (tools === undefined) return undefined;
  return { tools, doc: parseDoc(markdown) };
}

/** Report the drift; which side is wrong is a decision, not a derivation. */
export async function syncToolsDoc(root: string = REPO_ROOT): Promise<boolean> {
  const inputs = await readToolsDocInputs(root);
  if (inputs === undefined) {
    process.stderr.write(
      `tools-doc-sync: could not read ${DOC} and the tools array of ${MANIFEST} — ` +
        'both are required.\n',
    );
    return false;
  }
  if (inputs.tools.length === 0) {
    process.stderr.write(
      `tools-doc-sync: ${MANIFEST} describes no tools — regenerate it with ` +
        '`npm run sync:write` before trusting this gate.\n',
    );
    return false;
  }
  if (inputs.doc.sections.length === 0) {
    process.stderr.write(
      `tools-doc-sync: ${DOC} has no \`### 3.N \`tiktok_*\`\` sections — the ` +
        'heading form changed, and every comparison below would be vacuous.\n',
    );
    return false;
  }
  const problems = checkToolsDoc(inputs);
  if (problems.length === 0) return true;
  process.stderr.write(
    `tools-doc-sync: ${DOC} and ${MANIFEST} disagree about the tool surface:\n`,
  );
  for (const problem of problems) process.stderr.write(`  x ${problem}\n`);
  process.stderr.write(
    `  note: ${MANIFEST} is generated from src/tools/ — it is what the model reads.\n` +
      `  note: ${DOC} is a ratified spec — it is what a reviewer reads. Neither side\n` +
      '  is automatically right: a difference is either a code change that skipped its\n' +
      '  document, or a document stating an intent the code never grew. Read both texts\n' +
      '  above and fix the one that is wrong; this gate never writes either file.\n',
  );
  return false;
}

if (process.argv[1]?.endsWith('tools-doc-sync.js') === true) {
  const ok = await syncToolsDoc();
  process.exitCode = ok ? 0 : 1;
}
