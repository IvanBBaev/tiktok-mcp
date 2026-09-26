# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). What
counts as a breaking change, and how long a deprecated tool or environment
variable keeps working, is written down in
[docs/SECURITY.md § Compatibility and deprecation policy](docs/SECURITY.md#compatibility-and-deprecation-policy).

Every entry below is user-visible. Refactors, test-only changes and internal
plumbing stay in the commit history where they belong.

## [Unreleased]

### Added

- **MCP prompts and resources** (TOOLS.md § 7). Six read-only snapshots are
  now exposed as resources — `tiktok://auth/status`, `tiktok://user/info`,
  `tiktok://videos/recent` (one default page), `tiktok://creator/info`,
  `tiktok://publish/journal` (the newest 20 attempts across all profiles) and
  `tiktok://publish/{publish_id}/status`, a URI template listed by
  `resources/templates/list` whose path parameter is handed to the tool as
  `publish_id` — each the corresponding read tool called with its defaults,
  with `?account=<profile>` selecting the profile (on the journal it filters
  the rows instead) and `{?account}` templates advertised. The one fixed
  argument is the status resource's `wait_for_completion: false`: a snapshot is
  one status request, never a poll. A read goes through the same pipeline as a
  tool call (account resolution, scope check, redaction, truncation) and
  returns the usual JSON envelope as `application/json` text, so `ok: false` is
  a readable answer, not a protocol error. Three prompts, each one `user`
  message naming the exact tool for every step: `tiktok_post_video_guided`
  renders the canonical post-a-video flow with the failure discipline attached
  — preview without a `plan_id`, ask on `plan_incomplete`, show the consent
  line, execute with the same arguments plus the token, poll to
  `PUBLISH_COMPLETE`; `tiktok_post_photos_guided` renders the same flow for a
  photo carousel through `tiktok_post_photos`, asking about music and naming
  the offending `photo_urls[<i>]` on an unverified prefix;
  `tiktok_upload_draft_guided` takes exactly one of `video` / `photo_urls` and
  renders the matching draft flow — no creator pre-flight, poll to
  `SEND_TO_USER_INBOX`, stop on `pending_share_cap` — or a question instead of
  steps when given both or neither, and carries an optional `title` and
  `description` that a photo draft passes along and a video draft states as not
  sent. Both lists follow the tool packages: the prompts appear only with
  `publish-write` and `publish` both enabled, each resource only with its tool's package, and
  `notifications/resources/list_changed` is sent alongside
  `tools/list_changed` when the credential store changes.
- **Argument completion** (`completion/complete`, TOOLS.md § 7.3). The server
  now advertises `completions: {}` and answers a completion request for any
  listed prompt or resource: `account` — on every prompt and every resource —
  completes from the configured profile names, or from the locked name alone
  under `TT_LOCK_PROFILE`; `privacy_level` on `tiktok_post_video_guided` and
  `tiktok_post_photos_guided` from the four privacy levels; `publish_id` on
  `tiktok://publish/{publish_id}/status` from the ids in the local publish
  journal, newest first, each once, narrowed to the `account` in the request
  context the way `tiktok_list_publish_journal` filters. Matching is a
  case-insensitive prefix in the source's own order; at most 100 values are
  sent, with `total` and `hasMore` describing the rest. Every other argument
  completes to an empty list. No source makes a network request. An unknown
  prompt, an unknown resource ref or an argument the prompt or URI does not
  declare is a protocol error (`-32602`), the same class as an unknown prompt
  name; the source of an argument is not on the wire — `prompts/list` is
  unchanged.

- **Privacy Policy and Terms of Service** on the documentation site
  (`/privacy.html`, `/terms.html`). Every factual claim in the privacy policy is
  derived from the code it describes: the credential file's location and `0600`
  mode, the exact fields the publish journal records, and the egress allowlist
  that makes TikTok the only host the server can reach. The pages also state the
  disclosure that matters most and is easiest to omit — tool results flow into
  whichever AI client you point at this server.

- **Actionable hints on the two local refusals that only a human can clear.** A
  write refused because the file sits outside `TT_MEDIA_ROOT`, or because the
  `video_url` prefix is not a verified one, now carries a `user_action` hint
  naming the step and the variable to change instead of leaving the model to
  guess. They ride only on refusals that end the call with nothing created: once
  an upload has been initialised the attempt exists upstream and the next step is
  a status poll, not a person.

- **Five repo gates that hold the documentation to the code.** `cc-coverage`
  requires every corner case `docs/CORNER-CASES.md` defines to be named by a
  test, and every case a test names to be one the catalog defines — a catalog
  and a suite can each be complete on their own while describing different
  software. `site-sync` holds `site/` to the identity it advertises: the
  version in its structured data, the base URL it is served from, and the
  files it links to. `tools-doc-sync` holds `docs/TOOLS.md` to
  `docs/tool-manifest.json` — the normative document and the wire surface had
  no edge between them, so a one-word change to a tool description regenerated
  the manifest and left the specification asserting the old text, invisibly in
  both. `doctor-doc-sync` holds the check table in `docs/TROUBLESHOOTING.md` to
  the checks `doctor` actually runs, in the order it runs them — a promise the
  section makes in its own words and that nothing held it to, and one that had
  already broken: the `publish journal` row went on describing a fold the tool
  had stopped doing, in the one document whose reader is by definition someone
  whose install is already misbehaving. Those four are checked, not generated
  — the one value any of them writes is the site's JSON-LD `softwareVersion`,
  which `site-sync` sets to the package version under `npm run sync:write`,
  since that value carries no judgement; a wrong base URL or a broken link is
  only reported. Everything else stays a report because the repair for an
  unpinned corner case is a test, a missing page is a decision, overwriting
  TOOLS.md from the manifest would erase the question of which side lost the
  decision, and a doctor row is worth reading only for its
  second column — prose a generator would have to leave empty, and an empty cell
  that satisfies a gate is worse than the drift it replaced. `floors-doc-sync`
  is the exception that proves the rule — it _generates_ the coverage-floors
  table in `docs/TESTING.md` from `scripts/coverage-floors.json`, because there
  is no judgement in that one: the JSON is the decision and the table is a
  rendering of it. It was written after the table was found stating floors three
  phases old, with one whole rule missing — the table a contributor consults to
  learn which standard their file is held to.
- **`TT_HTTP_ALLOWED_HOSTS`** — an optional allowlist for the HTTP transport:
  comma-separated bare host names (DNS names, IPv4, IPv6 with or without
  brackets; no scheme, port or wildcard). When set, a request whose `Host`, or
  whose browser `Origin` host, is not on the list is refused with `403`, on any
  bind. Past loopback it is what stops DNS rebinding, which the Host/Origin
  check alone cannot; it is recommended with `TT_HTTP_INSECURE=1`, and the
  server warns at startup — and `doctor`'s `transport` row warns — when
  insecure mode runs without it. See
  [docs/CONFIGURATION.md § Transport](docs/CONFIGURATION.md#transport).
- **`doctor` reports the journal rotation lock** (`journal.ndjson.lock`) in
  its journal row: a lock held right now is noted, and one older than the
  15 s stale timeout warns with the directory to remove if no server is
  running. It only reports — appends never take the lock, and the next
  rotation breaks a stale one.

### Changed

- **The compatibility and deprecation policy now covers everything a caller can
  observe**, not just the tools and the environment variables
  ([docs/SECURITY.md](docs/SECURITY.md#compatibility-and-deprecation-policy)).
  The `ToolResult` envelope, the fields tools return in it, the shared
  error-code catalog and the closed `hints` vocabularies are named as published
  surface, because a model _branches_ on `error.code` and `hint.type`: renaming
  one breaks a caller more quietly than removing a tool, since the call still
  returns and only the branch stops matching.
- **`wait_for_audit` is no longer a member of the `user_action` vocabulary.**
  Under the widened surface above this has the shape of a breaking change, and
  is not one: no code path ever emitted it, so no result carried it and nothing
  could branch on it — the vocabulary shrank, the wire did not. An unaudited app
  is a standing condition of the installation, reported as a `note` alongside
  the preview or the successful post it does not stop.
- **The VS Code Marketplace publish now follows a successful npm publish**
  instead of firing on the `v*` tag, so a tag whose npm publish fails — the
  first-release case — ships nothing anywhere. Both follower workflows
  (`publish-vscode.yml`, `publish-mcp.yml`) accept only a successful,
  push-started `publish.yml` run of this repository and check out the tagged
  commit.
- The lint and test toolchain moves to its current majors: `eslint` 10 with
  `@eslint/js` 10 and `typescript-eslint` 8.67, `fast-check` 4 and `globals` 17.
  Dependabot no longer proposes `@types/node` majors (the types track the
  oldest supported Node, 22) or `@types/vscode` updates past `engines.vscode`,
  which `vsce` refuses to package. The pinned workflow actions move to
  `codecov-action` 7.1.1, `codeql-action` 4.38.1 and `deploy-pages` 5.0.1.
- `zod` moves to v4. The advertised JSON Schema now comes from zod's own
  `z.toJSONSchema`, so `zod-to-json-schema` is dropped and the runtime
  dependencies go from three to two. Integer arguments now also advertise their
  safe-integer bounds. `invalid_params` detail texts use zod 4's wording,
  except for a missing argument, which now reads `required argument is missing`
  where it read `Required`.

- **`TT_MAX_RETRIES` is now a retry cap, as documented.** Each idempotent read
  is tried once plus up to `TT_MAX_RETRIES` retries, the same way
  `TT_CHUNK_RETRIES` works for upload chunks. The value used to be applied as
  the total attempt count, so the default `3` allowed three attempts (two
  retries); it now allows up to four. Set it one lower to keep the old
  behaviour. Publish inits are still never retried.

- **A `char_budget` truncation no longer offers a cursor.** When the character
  budget, not the item cap, cuts a paged result, the dropped items were never
  delivered, so resuming from the page's cursor would skip them. The result now
  carries no `truncated.resume_cursor` and no `meta.next_cursor`, and the note
  asks the model to narrow the request (a smaller `max_count`) instead of
  paging on. An `item_cap` truncation is still resumable.
- **HTTP shutdown now drains.** Once `close()` starts, new requests get `503`;
  in-flight `POST` / `DELETE` requests get up to 10 seconds to finish, so a
  publish mid-upload can still record its journal outcome instead of being
  left `unknown`. `GET` SSE streams are not waited for, since they have no
  end. Past the budget a warning is logged and the requests still in flight
  are aborted, then the sessions and the listener close.
- **Completing a `publish_id` no longer re-reads the whole journal on every
  keystroke.** The folded journal is reused while neither generation's size,
  modification time or inode has changed; any append or rotation, from any
  process, re-reads it.

- **`login` defaults to the locked profile.** Without `--profile`, `login`
  now targets `TT_LOCK_PROFILE` when it is set, then `TT_ACTIVE_PROFILE` — the
  same default `doctor` and the server use — so a locked installation no
  longer logs in a different account than the one it serves.
- **`login` exit codes for existing credentials.** Logging in over a profile
  that already holds tokens, with no terminal to confirm on and no `--force`,
  now exits `2` (usage: re-run with `--force`) instead of `1`. Answering "no"
  at the prompt still exits `1` and changes nothing.
- **Retry settings have upper bounds.** `TT_MAX_RETRIES` and
  `TT_CHUNK_RETRIES` now accept at most `10`, and `TT_TOKEN_REFRESH_SKEW_S` at
  most `43200` (twelve hours — half the access token's 24 h lifetime; at the
  full lifetime every call would refresh); a larger value is a configuration
  error at startup.
- **The coverage gates are stricter.** The `ignore-hints` gate also counts
  Node's `node:coverage ignore next` / `disable` / `enable` hints, charges a
  `next N` its extra lines and an unclosed block every line to the end of the
  file, and fails an unclosed block. `coverage:gate` fails on a floor rule that
  matches no source file (`STALE RULE`) instead of printing a note, so a renamed
  file cannot silently leave its stricter floor behind. The hint opener mirrors
  `v8-to-istanbul` and has no trailing word boundary, so `c8 ignore starting …`
  — which the converter honours as `start` — is counted as a block too.
- **The stdio server drains on a signal.** On `SIGINT` or `SIGTERM` the calls
  in flight get up to 10 s to finish before the transport closes. A request
  that arrives once the drain has started is refused with JSON-RPC `-32000`
  `Service Unavailable: the server is shutting down` — the stdio counterpart
  of HTTP's `503` — instead of being started and then cut off. Requests are
  counted per id, so a client that reuses an id still in flight cannot end the
  drain early with the first answer. A closed stdin still ends the session at
  once, since there is no client left to answer — including when it closes
  while the drain is already waiting.
- **`tiktok_list_publish_journal` `since` is strict.** It accepts a date
  (`2026-01-01`, read as UTC midnight) or a date-time with `Z` or an explicit
  offset. A zone-less date-time — which `Date.parse` reads as local time — or
  any looser string is now `invalid_params` instead of a filter at a
  machine-dependent instant.
- **The release guard counts only list items as changelog entries.** A bullet
  or a numbered item is an entry; a bare `### Added` heading is not, so an
  empty template group under `[Unreleased]` no longer blocks a release and a
  released section of headings alone no longer passes as listing changes.
- **A `FILE_UPLOAD` init answered without an `upload_url` names its
  `publish_id`.** The `upstream_error` message now quotes the id TikTok minted
  (which will never receive bytes), for whoever checks upstream.

### Removed

- **`TT_MAX_CONCURRENT`.** It was parsed, defaulted to 4, type-checked and
  documented in four places as a per-host concurrency semaphore, and read by no
  line of the server: the semaphore was specified and never built. Setting it
  changed nothing, so nothing that worked stops working. What actually bounds
  upstream pressure is the per-profile publish token bucket (`TT_PUBLISH_RPM`);
  concurrent calls on the HTTP transport are deliberately unbounded in v1, and
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) now says so instead of describing
  a limit that did not exist. A `TT_MAX_CONCURRENT=` line left over in an
  existing `.env` needs no action: this build reports it as an unknown key,
  starts anyway, and preserves the line verbatim the next time it rewrites the
  file — the same path any forward-incompatible key takes (CC-F1).

### Fixed

- CI failed its production-dependency audit on a high advisory in the
  transitive `fast-uri` (`npm audit --omit=dev --audit-level=high`). The
  lockfiles now resolve `fast-uri` 3.1.8, `hono` 4.13.8, `qs` 6.16.0 and the
  dev-only `js-yaml` 4.3.2, and `npm audit` reports no advisories in either
  the root or the `extension/` package. No declared range changed.
- The site advertised `softwareVersion` `0.0.0` in its structured data after the
  0.7.0 release, and nothing compared the two.
- `sitemap.xml` and `robots.txt` pointed at
  `https://ivanbbaev.github.io/tiktok-mcp-ai/` — the npm package name where the
  repository slug belongs, so neither resolved.
- `og:image` and `twitter:image` referenced an `og-image.png` that was never
  committed, leaving every link preview broken. The banner is now rendered from
  the existing SVG, and `twitter:card` is `summary_large_image` so it is shown
  at the size it was drawn for.
- The README described `TT_TOOL_PACKAGES` and `TT_PACKAGES_DENY` as "comma/space"
  lists in two places. The parser splits on the comma alone, so the space form
  was not a lenient spelling of the same value — it parsed as one package name
  that does not exist and the whole configuration was refused at startup.
- `docs/AUTH.md` listed six default OAuth scopes, including `video.upload`. The
  request is derived from the enabled packages, and the default `core` profile
  asks for five; `video.upload` is added only when `publish-write` is enabled.
  Following the old text meant asking a sandbox app for a scope its enabled
  packages cannot use.
- The privacy policy page said "unofficial" but never disclaimed affiliation,
  while the terms and the landing page both did — and the privacy URL is the one
  an app reviewer opens directly. The VS Code extension's Marketplace
  description, the single line shown in search results, carried no unofficial
  marker either.
- `tiktok-mcp-ai doctor` reported the publish journal by file size and told the
  user that "intent/outcome reconciliation arrives with the publish tools". The
  publish tools shipped in 0.7.0 and the journal has recorded intents and
  outcomes ever since, so the one row whose job is to tell the operator the
  truth was describing a build that no longer exists. It now folds the journal
  the way `tiktok_list_publish_journal` does and reports how many attempts are
  recorded and how many of those never reached an outcome — the CC-E10 state,
  where the request may have been sent and the post may exist — with the two
  tool calls that settle it. A machine that has never published is still told
  exactly that; a journal that exists but cannot be read used to be reported as
  "no publish has been recorded yet", which was the worst available answer, and
  is now named as unreadable; and a last record torn off by a crash is counted
  as damage instead of stopping the run.
- **A secret could survive redaction when the length cap bisected it.** Upstream
  response bodies are both redacted and truncated before they reach an error
  message, and truncation ran first. `redactText` scrubs registered secrets by
  exact match, so a token the cap had already cut in half was no longer a match:
  its surviving prefix reached the message, and the second redaction pass that
  `TikTokError` performs on construction could not put the halves back together
  to recognise it. Redaction now runs before the collapse and before any caller
  truncates, which is also the only order in which the later pass is free.
- **`error.code` and `log_id` from upstream are now length-capped too.** The
  human-readable `message` was bounded and the two identifiers beside it were
  not, although a hostile or broken server controls all three equally — so the
  budget the cap exists to defend could be spent through the fields nobody
  thought of as text.
- **A credential file removed mid-read reported "no file yet".** The read was a
  `readFile` followed by a separate `stat` for the permission bits, and two path
  lookups can land on two different inodes. Losing the race produced the one
  answer the function exists to avoid — you are not logged in — while the tokens
  it had just read successfully were still in hand. It is one open handle now,
  so the bytes and the mode always describe the same file.

- **A long-running server could log an account out on its third token
  refresh.** With `TT_REFRESH_TOKEN` pinned in the process environment (a client
  `env` block, for example), the server remembered only the last refresh token
  it had spent. After two rotations the pinned original was no longer that last
  one, so the third refresh re-spent it — TikTok had already rotated it away —
  and the account was logged out. The server now remembers every refresh token
  it has spent and never sends one again.
- **The env-file lock could delete another process's live lock.** A holder that
  stalled for longer than the stale timeout could have its lock reclaimed by a
  second process, then touch or remove that process's lock as if it were still
  its own. The holder identity is now checked before each heartbeat and before
  release, so a lock that changed hands is left alone.
- **A waited write dropped the reason it failed.** With
  `wait_for_completion: true`, a write tool that polled to a terminal `FAILED`
  returned the status and nothing else: the `fail_reason` TikTok sent back on
  the poll, and the recovery text it maps to, were lost, and the caller had to
  call `tiktok_get_publish_status` again to learn why. The applied result now
  carries `fail_reason` and `fail_recovery` — the same Appendix A texts the
  status tool returns (TOOLS.md § 3.8). The two draft tools also stopped
  telling the user to open the TikTok app for a draft whose waited status is
  `FAILED`: it never reached the inbox, so there was nothing to open.
- **`TT_VERIFIED_URL_PREFIXES` matched as a raw string prefix.** A configured
  `https://cdn.example.com` admitted `https://cdn.example.com.attacker.net/…`,
  and a host spelled in another case was refused. A URL now matches when its
  origin — scheme, host and port, the host compared case-insensitively — equals
  the prefix's and its path starts with the prefix's path.
- **The stdio server outlived its client.** Closing stdin is how an MCP client
  ends a stdio session, but the server kept running until it was sent `SIGINT`
  or `SIGTERM`. It now shuts down when stdin closes. A signal that arrived while
  the transport was still starting also left that transport running; it is now
  torn down once it is up.
- **`login` opened a truncated authorize URL on Windows.** The browser was
  started through `cmd /c start`, and `cmd.exe` reads every `&` in the URL as a
  command separator, so the browser got the URL cut at its first parameter. It
  is now opened with `rundll32 url.dll,FileProtocolHandler`, which takes the
  URL as one argument with no shell in between.
- **A prerelease tag would have failed the Marketplace publish after npm had
  already shipped it.** The VS Code Marketplace rejects semver prerelease
  versions, and a `vX.Y.Z-rc.N` tag is allowed through to npm's `next`
  dist-tag. `publish-vscode.yml` now skips its publish step for such a version,
  so a prerelease ships to npm only. The packed-artifact smoke also runs the
  bin target `package.json` declares rather than a path derived from the bin
  key, so a renamed or mistyped target fails the smoke instead of passing on a
  stale launcher still in the tarball.
- **Documentation corrections.** An unknown `TT_ACTIVE_PROFILE` does not stop
  the server at startup, as `docs/CONFIGURATION.md` said: startup only checks
  the name's shape, each call fails with `unknown_profile` and `doctor`'s
  `profiles` check fails. The Node version symptom in `docs/TROUBLESHOOTING.md`
  now quotes the launcher's actual message, and the README lists `login`'s exit
  code `2` for a usage error. Two rows of `docs/TOOLS.md` Appendix A now carry
  the texts the server returns: `duration_check_failed` points at
  `tiktok_get_creator_info`, and `internal` asks for the publish_id and the
  time of the attempt rather than a `log_id` a FAILED status does not have.
- **A `char_budget` truncation handed out a cursor that skipped items.** See
  Changed: the truncated result no longer carries `next_cursor` or a
  `resume_cursor`.
- **An unreadable credential store failed `tools/call` as a JSON-RPC fault.**
  A failure reading the profiles is now a tool error envelope, like every other
  failure, so the model gets a code and a remediation it can act on.
- **HTTP sessions leaked their server handle, and a shutdown raced new
  requests.** Each session's handle is now released when its transport closes,
  whether by `DELETE`, `close()` or an `initialize` that never became a
  session, so the credential-watch set tracks live sessions only. Once
  `close()` begins, every new request is answered `503` with JSON-RPC `-32000`
  `Service Unavailable: the server is shutting down`.
- **Two concurrent calls could both send the same publish.** The journal only
  sees a publish after its init returns, so a second identical call made while
  the first was still in flight passed the duplicate check. An in-flight guard
  now refuses it with `possible_duplicate` and `details.in_flight: true`; wait
  for the other attempt before deciding to retry.
- **Profile keys in another case were ignored, a symlinked env file was
  replaced, and the temp file could be pre-created.** `TT_PROFILE_work_*` keys
  are now read for profile `WORK` (the exact spelling still wins). A write to a
  symlinked env file now goes through to its target and keeps the link. The
  temp file for the atomic write is created with `wx`, so an existing file at
  that path is never reused.
- **int64 ids beyond 2^53 lost precision.** A `public_post_id` (and any other
  int64 id) larger than `Number.MAX_SAFE_INTEGER` is now kept as the exact
  decimal string TikTok sent, never rounded through a JavaScript number.
- **An upload could fail after its last chunk had landed, and a vanished file
  surfaced a raw errno.** A `416` on the final chunk whose reported progress
  covers the whole file now counts as complete. A media file that disappears
  between resolution and `stat` is reported as `file_not_found`.
- **Upload log fields were redacted.** The chunk-count field is renamed from
  `upload_chunks` to `total_chunks`, the allowlisted name, and
  `backoff_ms` is now on the log allowlist, so neither is redacted.
- **A millisecond setting above 2^31−1 fired after 1 ms.** Node clamps a larger
  timer delay to 1 ms, so a very large `TT_*_MS` value meant the opposite of
  what it said. Every millisecond setting now has a maximum of `2147483647`,
  and a larger value is rejected at startup with the other validation errors.
- **The user-info field check accepted an inherited property name.** A
  requested field name is now checked with `Object.hasOwn`, so a name such as `constructor` or
  `toString` is rejected as an unknown field instead of passing the check.
- **A rotation could hide a recent publish from the duplicate guard.** The
  guard read only the active journal generation, so an intent rotated into
  `.1` right after it was written — by this process on its next publish, or by
  another process at any time — no longer counted, and the same payload could
  be re-sent inside its own 10-minute window. When the whole active file fits
  the guard's 256 KiB budget, it now also reads the newest part of `.1` within
  the remaining budget. Whether the active file fits is decided on the raw
  bytes read against that descriptor's size, not on the decoded text: with
  invalid UTF-8 in a cut tail the text length could exceed the budget, the
  `.1` read failed as unreadable and the guard was silently skipped.
- **A scoped tool on a never-logged-in profile blamed a missing scope.** The
  `missing_scope` message said the account "was authorized without scope X"
  and asked for `login --scopes X`, which would have granted that one scope
  alone. A profile with no stored credentials — not configured at all, the
  default profile before the first login, or a profile holding only app keys
  — now gets its own sentence ("has no stored credentials, so it grants no
  scopes"), `configured: false` in `details`, and a plain
  `login --profile <profile>` in both text and hint.
- **The file uploaded could differ from the file verified.** Each chunk was
  read by path, so a file renamed or replaced mid-upload could splice other
  bytes into the post. The media file is now opened once and every chunk and
  retry reads from that descriptor; it must be the file the apply verified
  (size, mtime, device, inode), else `plan_mismatch` before the first PUT, and
  an in-place modification between chunks fails with `upload_interrupted`
  ("the media file was modified during the upload"). Chunk bodies are read
  with positional 1 MiB reads on that descriptor rather than a file read
  stream, which closed the shared handle when destroyed (breaking the next
  retry) and leaked a listener per chunk (`MaxListenersExceededWarning` after
  ten). A file truncated mid-chunk fails that chunk and is reported the same
  way.
- **The DNS pre-flight missed non-canonical and embedded-IPv4 addresses.** IPv6
  answers are now normalized before classification, so spellings such as
  `0:0:0:0:0:0:0:1` or `::ffff:7f00:1` are caught, and the IPv4 embedded in
  `::/96`, `::ffff:0:0/96`, NAT64 `64:ff9b::/96` and 6to4 `2002::/16` is
  classified. Also refused: `64:ff9b:1::/48`, Teredo `2001::/32`,
  `2001:db8::/32`, `100::/64`, site-local `fec0::/10`, `192.0.0/24` and the
  three IPv4 documentation ranges, and any answer that is not an IP literal.
- **`TT_UPLOAD_TIMEOUT_MS` did not say what it implies.** It applies to each
  chunk PUT attempt, and a chunk can reach ~128 MB, so the 120 s default needs
  about 1.07 MB/s sustained upload for the largest chunk.
  `docs/CONFIGURATION.md` and `docs/TROUBLESHOOTING.md` now say so and tell a
  slow uplink to raise it.
- **A tool `account` was matched case-sensitively.** Profile names are stored
  upper-cased, so `account: "work"` failed with `unknown_account` although
  profile `WORK` existed. The caller's value is now trimmed and upper-cased
  before it is compared — for profile resolution, the `TT_LOCK_PROFILE` check,
  the `tiktok_list_publish_journal` filter and the `publish_id` completion's
  account context. `unknown_account` still echoes the spelling as given.
- **The DNS pre-flight admitted reserved IPv6 and IPv4 ranges.** It now also
  refuses `192.88.99.0/24`, SIIT `::ffff:0:0:0/96` (classified by the embedded
  IPv4), the rest of `0000::/8`, IETF protocol assignments `2001::/23` (incl.
  benchmarking and ORCHID), documentation `3fff::/20` and SRv6 `5f00::/16`.
- **A guided prompt could steer to tools the client could not see, and its
  values could inject a step.** Each prompt now declares the packages its steps
  name (`requires: ['publish']`) and is listed, served and completed only while
  both `publish-write` and `publish` are enabled. Every user value rendered into
  a step (video, title, description, account, privacy level, photo URLs) is
  JSON-quoted, so a quote or a newline in it cannot start a new instruction.
- **`TT_LOCK_PROFILE` did not bound the publish journal.**
  `tiktok_list_publish_journal`, the `tiktok://publish/journal` resource and
  the `publish_id` completion now show the locked profile's attempts only;
  another `account` filter narrows them to nothing. `docs/SECURITY.md` no
  longer claims the `account` argument is removed under the lock — it is kept,
  and any other name answers `unknown_account`.
- **A failing completion and an unreadable env file leaked a local path.** A
  completion whose candidates cannot be computed (an unreadable journal or
  profile store) is now logged as a warning and answered with an empty list.
  An env file that cannot be read or parsed now lists as no profiles, so every
  scoped tool shows as unavailable, matching what the credential watch logs.
  Before, `tools/list` failed with `-32603` and the absolute env-file path.
- **Resource URIs were repaired instead of refused.** A URI with userinfo or a
  port, a tab, CR or LF, a `.` / `..` segment (plain or `%2e`-encoded), a query
  key that is not literally `account`, an `account` without `=` or an empty
  query pair is now `Unknown resource` rather than being normalized by the URL
  parser into a different one. The `account` value is percent-decoded only, so
  `+` stays a plus.
- **One failed list-changed notification suppressed the other.**
  `notifyListChanged` now sends both `tools/list_changed` and
  `resources/list_changed` and rethrows the first failure afterwards.
- **The HTTP transport had no body or session bounds.** Request bodies are
  capped at 4 MiB (`413 Payload Too Large` with `connection: close`, and a
  declared `content-length` over the cap is refused before reading),
  unparsable JSON gets `400` / `-32700`, at most 128 sessions are live (one
  more `initialize` gets `503` `too many open sessions`), and a session idle
  for 30 minutes is closed when the next session opens. These are fixed
  limits, not settings.
- **`CredentialWatcher.stop()` did not wait for a `poll()` in flight.** It now
  awaits a poll started through `poll()` as well as the loop's own, and
  `poll()` after `stop()` resolves `false` without reading.
- **A crash right after a journal rotation or creation could lose it.** The
  journal directory is now fsync'd after a rotation's rename and after an
  fsync'd append that created the file, so the rename or the new directory
  entry survives. It is best-effort: where the platform cannot sync a
  directory (Windows) it is skipped with a debug log.
- **Two processes rotating the journal at once could lose a rotated
  generation.** Both could see an over-cap file and both rename it, the second
  retiring the fresh generation over the one the first had just rotated out.
  Rotation now takes a cross-process lock of its own, `journal.ndjson.lock`
  beside the journal, and re-checks the size under it. The lock is separate
  from the env-file lock, so a publish never waits behind a token refresh, and
  appends still take no lock. If the lock cannot be taken within 2 s, the
  rotation is skipped with the usual warning
  (`could not rotate the publish journal; it keeps growing`) and the publish
  goes ahead. A lock left behind by a crash is reclaimed after 15 s.
- **HTTP shutdown could abort a publish whose client had disconnected.** The
  drain waited only for open `POST` responses, so a client that hung up mid
  tool call left nothing to wait for, and closing its session aborted the
  handler — a publish mid-upload then ended `unknown` in the journal. The drain
  now also waits for every JSON-RPC request that has not been answered yet; a
  request the client cancels (`notifications/cancelled`), or one whose session
  closes, stops being waited for. It is still bounded by the same 10 s budget.
  A session whose `initialize` completed after shutdown had already closed the
  others is now closed at once instead of lingering, and a session that failed
  to connect releases its runtime.
- **`TT_HTTP_ALLOWED_HOSTS` could refuse a listed host written another way.**
  Entries and the `Host` / `Origin` hostnames are now compared in the form the
  URL parser gives — lowercased, IPv6 compressed (`0:0:0:0:0:0:0:1` → `::1`),
  numeric IPv4 shorthands expanded (`127.1` → `127.0.0.1`) — so any spelling of
  a listed name matches. An IPv6 zone id (`fe80::1%eth0`) in the list is now a
  configuration error, since no `Host` or `Origin` can carry one.
- **`TT_HTTP_INSECURE=1` warned on a loopback bind.** The startup log and
  `doctor`'s `transport` row reported the bind as reachable off-box, and the
  missing allowlist as a DNS-rebinding gap, even when the server listened on
  loopback only. Both warnings now fire only on a non-loopback bind.
- **A busy or stale journal rotation lock was reported as the credential
  file's.** Its messages now call it the journal rotation lock guarding the
  publish journal, so they no longer send you to the env file.

- **Cancelling an apply mid-send let a blind retry post twice.** A caller
  cancellation that landed while the init or the upload was in flight was
  journaled as a clean failure, which the duplicate guard lets through — yet
  the init or the last chunk may have completed anyway. It is now
  `network_ambiguous`, journaled `send_ambiguous` (mid-upload with the
  `publish_id` and chunk, also in `details.publish_id`), so the guard blocks
  an unforced retry. A cancel before the send began is still a clean `error`.
- **A local file swapped between preview and apply was not always caught.**
  The file's identity (size, modification time, device and inode) is now
  bound to the plan itself — never sent upstream and never part of the
  payload digest — and applying after the file changed fails with
  `plan_mismatch`, `details.reason: "file_changed"`: "The file changed since
  plan: the file at file_path no longer matches the size, modification time
  and identity captured when the preview was generated. Generate a fresh
  preview and apply again."
- **The duplicate guard matched across accounts.** An attempt on one profile
  blocked an identical payload on another (and `force: true` on one waved the
  other through). The guard is now per profile, compared in canonical
  spelling, and `possible_duplicate` names the matched attempt's profile.
- **An apply that lost its plan could still spend a rate token.** Step 7 now
  peeks the local rate bucket, consumes the plan, and only then takes the
  token, so a plan consumed by a concurrent apply during the duplicate
  guard's journal read is refused with `plan_not_found` at no cost to the
  bucket.
- **A whitespace-only `account` was rejected as an unknown profile.** It now
  counts as absent: tools resolve the active profile (or the locked one under
  `TT_LOCK_PROFILE`), and `tiktok_list_publish_journal` filters nothing.
- **Breaking a stale env lock could delete a successor's fresh lock.** A
  breaker that lost the race to another process removed the directory that
  process had just created. The stale lock is now renamed to a unique
  tombstone and deleted only after verifying it is the directory whose age
  was measured; a mismatch is put back.
- **The HTTP transport answered 400 to an accepted Host spelled
  non-canonically.** A `Host` such as `127.1:<port>` passed the DNS-rebinding
  check but the SDK's request adapter rejected it when the port was 60000 or
  higher. Once accepted, the `Host` is now re-spelled canonically before the
  request reaches the SDK.
- **IPv6 egress admitted non-global ranges.** Outbound requests now refuse
  every IPv6 address outside global unicast `2000::/3`.
- **The server reused a refresh token it had read at startup.** Credentials
  were resolved from an environment that froze the env file's startup tokens,
  so a token another process rotated, or `login --revoke` cleared, was still
  sent. The server now reads the live process environment plus the env file.
- **`login --revoke` exited 0 when the local clear failed.** It now exits 1
  and says what happened upstream.
- **`doctor` exited 0 with an unreadable profile.** An unreadable profile
  record is now a failed check.
- **The `.pre-schema<N>` backup was briefly readable under the umask.** It
  was copied at the umask's mode and tightened afterwards; it is now created
  owner-only (0600) by the open itself.
- **Two identical publishes started together could both pass the duplicate
  check.** The in-flight guard was registered after the journal read, so two
  concurrent calls both saw no prior record. The entry is now registered
  before the read and released on every refusal.
- **A lost response to the last upload chunk was recorded as a failed
  upload.** A network error or timeout on the final chunk may follow a
  complete upload, so it is now `network_ambiguous` and journalled as
  `send_ambiguous` (CC-G4) — check the status before retrying. A `416` resync
  to the end completes the upload.
- **Writing a per-profile key could leave a case-variant duplicate in the env
  file.** A key such as `TT_PROFILE_work_REFRESH_TOKEN` is now rewritten in
  place in its canonical upper-case spelling, and the other variants are
  dropped (CC-F4).
- **The client secret and a revoked access token were not registered for
  redaction.** `client_secret` is now registered when a profile is read and
  when a code is exchanged, and `login --revoke` registers the access token
  before the request.
- **A running server could resurrect a profile revoked by another process.**
  With no refresh token left on file or in the environment, the server spent
  the one it still held in memory. It now drops the cached tokens and fails
  with `auth_expired`.
- **Inode reuse could make the stale-lock breaker delete a live lock.** On a
  file system without birth time, the tombstone check now also compares the
  measured mtime.
- **HTTP transport edge cases.** The idle sweep no longer closes a session
  with unanswered calls; a `Host` with an invalid port gets `403` instead of a
  bare `400`; a `notifications/cancelled` is still delivered during the
  shutdown drain, so the drain can finish early; and a `POST` whose body
  completes after the drain began gets `503` instead of `404`.

- **Any failure of a final chunk whose earlier attempt lost its answer was a
  clean failure.** Once an attempt at the last chunk has timed out or lost its
  connection, the retry's failure — a retryable 5xx that runs out, or a
  terminal `403`, `404` or `400` — may follow an upload the lost attempt
  already completed. It is now `network_ambiguous` and journalled as
  `send_ambiguous` (CC-G4). A final-chunk `416` whose progress is one byte
  short of the total is `network_ambiguous` too, since whether TikTok reports
  a count or a last-byte index is not yet pinned (probe P-11); progress at or
  past the total still completes the upload.
- **Upload progress could run ahead of a backward `416` resync.** A resync
  that moves the position back now moves the reported chunk position back as
  well; the MCP progress notifications themselves never decrease.
- **A publish that threw after its in-flight registration blocked the same
  payload until restart.** The entry leaked for the life of the process, and
  every later identical publish was refused as `possible_duplicate`. Any
  exception the guards throw after registering it now releases the entry.
- **Handing a stale lock back could replace a third process's fresh lock.**
  The breaker renamed its tombstone back whenever the path was held again, and
  on POSIX that rename replaces an empty directory — a lock another process
  had just created. The tombstone is now renamed back only onto a free path.
- **A `Host` port with leading zeros was refused.** `Host: 127.0.0.1:080`
  names the bound port 80 but failed the string comparison with `403`; the
  port is now re-spelled canonically before the comparison.
- **`login --profile --force` took `--force` as the profile name.** A
  separated `--profile` value that looks like a flag is now "`--profile` needs
  a value", and an invalid profile name is a usage error (exit `2`) before
  anything runs, instead of a login that ran and failed (exit `1`). The name is
  upper-cased as before.
- **The `unknown_profile` remediation named a command that does not exist.**
  It now says `tiktok-mcp-ai login --profile <name>`.
- **A `user: null` answer from `/v2/user/info/` was passed on as the user.**
  It is now a malformed payload (`upstream_error`), like a missing `user`.

- **A short journal write passed for a recorded line.** A write that stored
  only part of a record (a full disk) now counts as a failed append: the result
  carries `journal: "unavailable"` and the publish is unaffected. An append
  after a torn last line now starts on a new line, so the fragment can no
  longer swallow the next record.
- **At the plan cap, a live plan could be evicted ahead of a used one.** Used
  plans — which can only answer `plan_not_found` — are now evicted first.
- **A publish init answered without a readable `publish_id` invited a second
  post.** It was `upstream_error`, journalled `error`, which the duplicate guard
  lets through — yet the init may have been accepted. It is now
  `network_ambiguous`, journalled `send_ambiguous`, and the guard holds.
- **An unreadable gateway answer to a publish init was a plain failure.** A
  `2xx` or `5xx` whose body is not JSON or not a JSON object, or a `5xx`
  envelope without `error.code`, comes from a proxy in front of TikTok and
  says nothing about whether the init was accepted. It is now
  `network_ambiguous`, journalled `send_ambiguous`, exactly like an init
  timeout (CC-B2, CC-B5). A `4xx`, or an envelope with an explicit error code,
  keeps its normal mapping.
- **A `videos[]` entry without an id was passed on.** An entry that is not an
  object with a string `id` now makes the `/v2/video/list/` or
  `/v2/video/query/` answer a malformed payload (`upstream_error`); `id` is what
  `missing_ids` and every follow-up call are keyed on.
- **`login --manual` did not say why it stopped when stdin ended.** Input that ends
  before a redirect URL is pasted now prints "No redirect URL was pasted (the
  input ended); nothing was changed." and exits `1`.
- **`doctor --profile` accepted a flag or an invalid name as the profile.**
  `--profile` followed by another flag (`--profile --json`) is now a missing
  value, and an invalid profile name is refused; both are usage errors (exit
  `2`), like the same mistakes on `login`.
- **A rate-limit answer without a JSON body was an upstream error.** A `429`
  whose body is empty, an HTML page, or JSON that is not an object — an edge
  or proxy answering for TikTok — is now `rate_limited` with the wait hint
  (`Retry-After` when sent), like any other `429` (CC-B8), instead of
  `upstream_error`.
- **Concurrent `initialize` requests could overshoot the HTTP session cap.**
  The cap counted only sessions already open, so several `initialize`
  requests racing through the check could together exceed 128 live sessions.
  A session now holds a reserved slot from the moment it is admitted until it
  is registered as live (or has failed), when the live count takes it over.
- **A token refresh that outlived a cache reset could drop a newer one.** A
  refresh still running when `resetTokenCache` cleared the in-flight map
  removed, on settling, whichever refresh had since taken its place, so the
  next caller started a third one alongside it. A refresh now removes only its
  own entry.
- **An `ok` envelope with a non-object `data` crashed the reader.** A `2xx`
  with `error.code: "ok"` whose `data` is `null`, a scalar or an array is now
  refused before any reader sees it (CC-B2). On a publish init it is
  `network_ambiguous` — the init may have been accepted — so it is not
  retried, is journaled `send_ambiguous` and the duplicate guard keeps
  blocking a re-send; on any other call it is `upstream_error`, not retried.
- **A resource URI with an empty trailing `#` was accepted.** `URL` reports a
  bare trailing `#` as no fragment, so `tiktok://auth/status#` read as the
  canonical URI. Any `#` in a resource URI now makes it unknown (`-32602`).
- **Documentation corrections.** `server.json` is hand-maintained, not
  generated, and declares only `TT_CLIENT_KEY` and `TT_CLIENT_SECRET` (both
  secret) plus the optional `TT_MEDIA_ROOT`. A `TT_OAUTH_BASE_URL` that is not
  an absolute `http(s)` URL is an `invalid_configuration` error at startup; a
  well-formed one is honoured only when its host is loopback and is otherwise
  ignored.

### Security

- **`login --revoke` could leave a rotated access token alive upstream.** If a
  running server refreshed the profile between the revoke call and the local
  clear, the new access token was cleared from disk but never revoked. The
  profile is now re-read under the env-file lock and that token is revoked too.
- **Release and CI workflows keep their tokens away from install scripts.**
  `ci.yml` runs with a read-only `contents: read` token, `publish.yml` checks
  out with `persist-credentials: false`, and the npm used for trusted
  publishing is pinned to `12.1.0` instead of `npm@latest`. `publish-mcp.yml`
  installs `mcp-publisher` from a pinned release (`v1.8.1`) and verifies its
  sha256 before running it, instead of whatever `releases/latest` served. A
  manual `workflow_dispatch` of `publish-mcp.yml` or `publish-vscode.yml` must
  run on a `v*` tag and runs `release:guard` first, instead of skipping every
  condition the automatic trigger checks. `publish.yml` fails if the dist-tag
  cannot be resolved, instead of publishing under an empty one.
  `publish-mcp.yml` and `publish-vscode.yml` now also check out with
  `persist-credentials: false`.
- **An unparseable `upload_url` could leak its `upload_token`.** The token
  was registered as a secret only when the `upload_url` parsed as a URL, yet
  the refusal to PUT to an unparseable one quotes it. An `upload_token=` value
  in such a string is now registered too, so the refusal is redacted.
- **A symlinked env file and its target took different locks.** The env-file
  lock and the atomic write now key on the file's canonical path, so a writer
  going through a symlink and one naming the target serialize on one lock
  instead of both writing at once. A dangling symlink — or a chain of them,
  followed to its end (up to 40 links) — is written through to its final
  target (whose directory is created) and every link is kept, instead of one
  being replaced by a regular file; each link in a chain takes the same lock.
  A symlink loop is left as given and reported by the read. `doctor` reports the lock at the canonical path.

## [0.7.0] - 2026-08-26

First published release. The version reflects how much of the planned surface is
built and exercised, not a promise of stability: it is pre-1.0, so a minor bump
may still break a contract — see
[docs/SECURITY.md § Compatibility and deprecation policy](docs/SECURITY.md#compatibility-and-deprecation-policy).

### Added

- **11 tools** across the `auth`, `user`, `video`, `publish` and `publish-write`
  packages: `tiktok_get_auth_status`, `tiktok_get_user_info`,
  `tiktok_list_videos`, `tiktok_query_videos`, `tiktok_get_creator_info`,
  `tiktok_get_publish_status`, `tiktok_list_publish_journal`,
  `tiktok_post_video`, `tiktok_upload_video_draft`, `tiktok_post_photos` and
  `tiktok_upload_photos_draft`.
- **Plan-then-execute write safety** on all four publishing tools: a call
  without a `plan_id` previews and mints a single-use, digest-bound token, and a
  call with one executes exactly the previewed payload — or nothing.
  `TT_WRITE_MODE` (`plan` / `apply` / `deny`) sets how strict that is.
- **Append-only publish journal** (`journal.ndjson`): a write-ahead intent
  record before each publish and an outcome after it, readable through
  `tiktok_list_publish_journal`, with duplicate detection across restarts.
- **OAuth 2.0 (Login Kit) with PKCE**, including TikTok's lowercase-hex
  `code_challenge` deviation from RFC 7636, a single-accept loopback redirect,
  single-flight token refresh and revocation.
- **CLI**: `tiktok-mcp-ai login` (least-privilege scopes derived from the
  enabled tool packages), `login --revoke [--purge-journal]`, and
  `tiktok-mcp-ai doctor`, which reports configuration, token state and file
  permissions with every secret redacted. `doctor --json` prints the whole
  report as one versioned JSON document on stdout — and nothing else, on every
  exit path — so a readiness gate can consume it without scraping rows.
- **npx staleness check** in `doctor`: a copy running from the npx cache warns,
  with the cache-clear command for your platform (`rm -rf ~/.npm/_npx`,
  `%LOCALAPPDATA%\npm-cache\_npx`), because `npm cache clean` does not remove it
  and npx will otherwise keep re-running the version you first tried.
- **Multi-account profiles** (`TT_PROFILE_<NAME>_*`) with per-call `account`
  routing, and `TT_LOCK_PROFILE` for deployments that must not switch accounts.
- **Tool packages as an access policy**: `TT_TOOL_PACKAGES`,
  `TT_PACKAGES_DENY`, `TT_PACKAGES_READONLY` — a read-only deployment never
  holds a token carrying posting authority.
- **Resumable chunked uploads** for `FILE_UPLOAD` video posting, with local
  files confined to `TT_MEDIA_ROOT`, and `PULL_FROM_URL` posting restricted to
  verified URL prefixes.
- **Egress allowlist** (data host, anchored upload hosts, OAuth authorize host),
  a three-class HTTP retry matrix, per-host concurrency limiting and a local
  publish-rate token bucket.
- **Two transports**: stdio by default, and Streamable HTTP under
  `TT_TRANSPORT=http` with one MCP session per connection. The HTTP bind
  requires `TT_HTTP_TOKEN` on every request — including a loopback bind —
  validates `Origin` and `Host` against the bind as a DNS-rebinding defense, and
  refuses to serve off-box without TLS in front of it or an explicit
  `TT_HTTP_INSECURE=1`.
- **Live tool list**: the server watches the credential file and sends
  `notifications/tools/list_changed` when a profile is added, removed or
  re-scoped, so a `login` in another terminal updates the tools an
  already-connected client can see.
- **Credential storage in an env file** written atomically at `0600` under a
  cross-process lock, preserving comments, ordering and line endings on rewrite.
- **Secret redaction below every sink** — logs, tool results and the journal —
  and stdout kept clean for the stdio JSON-RPC stream.
- **Token-efficient results**: a size-budgeted JSON envelope
  (`TT_RESULT_CHAR_BUDGET`) with structured errors and actionable hints.
- Distribution manifests for the MCP registry (`server.json`), Claude Code
  (`.claude-plugin/`) and VS Code (`extension/`), plus the documentation site
  under `docs/`.
- Repo gates: generated README tool table, `.env.example` and
  `docs/tool-manifest.json`, a packed-tarball audit, per-area coverage floors,
  and a CI matrix over Node 22/24/26 on Linux, macOS and Windows.

[Unreleased]: https://github.com/IvanBBaev/tiktok-mcp/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/IvanBBaev/tiktok-mcp/releases/tag/v0.7.0
