/**
 * The interactive prompt seam: one question, one line of answer.
 *
 * `login` and `doctor` are the two commands that ask the operator something —
 * login for a pasted redirect URL (CC-A10, CC-A11), doctor for permission to
 * chmod an env file (CC-F3) — and both ask through `CliDeps.prompt`
 * (cli/index.ts:108). The seam lives here rather than inside either command
 * because it belongs to neither: written once per command it was the same three
 * functions, the same exclusion and the same test, twice.
 *
 * The split inside the seam is what keeps the exclusion down to a single line.
 * {@link readLine} is the reading, which is ordinary code over ordinary streams
 * and is tested as such; {@link defaultPrompt} is only the choice of *which*
 * streams, the part no test may make because the process's stdin belongs to the
 * test runner; and {@link promptOf} is the choice between the injected prompt
 * and the default, which a test observes as an identity rather than by entering
 * it.
 */

import { createInterface } from 'node:readline';

import type { CliDeps } from './index.js';

/**
 * One line of answer, asked on `output` and read from `input`.
 *
 * The half of the seam's default that does not need the process: no terminal,
 * no `process.stdin`, just a question written out and one line read back.
 */
export async function readLine(
  question: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    // `rl.question` never settles when the input ends first (EOF, Ctrl-D,
    // `< /dev/null`): the process would exit on an unsettled await instead of
    // answering. The close is raced so the caller gets a rejection it can report.
    // The callback form answers inside the `line` event, before an input that
    // ends right after that line can emit `close`; a promise answer would
    // settle a microtask later and lose the race to the rejection. A last line
    // with no newline (`printf code | …`) is flushed at EOF as a plain `line`
    // event that bypasses the question callback, so that event answers too.
    return await new Promise<string>((resolve, reject) => {
      rl.once('close', () => {
        reject(new Error('The input ended before an answer was given.'));
      });
      rl.once('line', resolve);
      rl.question(question, resolve);
    });
  } finally {
    rl.close();
  }
}

/**
 * The default prompt: one line from the process's stdin, asked on stderr.
 *
 * Never on stdout — `doctor --json` and `login`'s machine-readable output own
 * that stream. Production seam default: the seam is `CliDeps.prompt`
 * (cli/index.ts:108), the substitution is {@link promptOf}, and every test that
 * reaches a prompt injects its own (`test/login.test.ts:167`,
 * `test/doctor.test.ts:416`). Entering this instead would mean reading the test
 * runner's real stdin, which is the coupling the seam exists to prevent. What
 * is excluded is the binding of the two process streams and nothing else.
 */
/* c8 ignore next -- production seam default, replaced by injection in every test (cli/index.ts:108). */
export const defaultPrompt = (question: string): Promise<string> =>
  readLine(question, process.stdin, process.stderr);

/**
 * The prompt in force: the injected one, or {@link defaultPrompt}.
 *
 * The choice is split out from the call so that it can be *observed* without
 * being *made*. Written inline as `(deps.prompt ?? defaultPrompt)(question)`
 * the fallback arm is reachable only by entering it — that is, by reading the
 * test runner's stdin; returned as a value it is an identity `assert.equal`
 * settles, which is why this arm needs no exclusion.
 */
export function promptOf(deps: CliDeps): (question: string) => Promise<string> {
  return deps.prompt ?? defaultPrompt;
}

/** Asks `question` through whichever prompt {@link promptOf} yields. */
export async function ask(deps: CliDeps, question: string): Promise<string> {
  return await promptOf(deps)(question);
}
