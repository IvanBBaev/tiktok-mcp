/**
 * Tests for cli/prompt.ts — the interactive prompt seam shared by `login` and
 * `doctor`.
 *
 * The seam's point is that its only untestable part is the binding of the
 * process's own streams, so that is the only line excluded from coverage. These
 * tests take the other two halves: the reading, over streams a test supplies,
 * and the choice between the injected prompt and the default, asserted as an
 * identity rather than by calling it — calling it would read the test runner's
 * stdin, which is exactly what the seam exists to prevent.
 */

import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { ask, defaultPrompt, promptOf, readLine } from '../src/cli/prompt.js';

/** A sink that keeps what was written to it. */
function collectingOutput(written: string[]): NodeJS.WritableStream {
  return new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error) => void) {
      written.push(chunk.toString('utf8'));
      done();
    },
  });
}

test('the prompt asks on its output and answers with one line of its input', async () => {
  // What `CliDeps.prompt`'s default does once the streams are chosen for it: no
  // process, no terminal, just a question written out and a line read back.
  const input = Readable.from(['the-code\nnot this line\n']);
  const written: string[] = [];

  assert.equal(
    await readLine('Paste the redirect: ', input, collectingOutput(written)),
    'the-code',
  );
  assert.match(written.join(''), /Paste the redirect: /);
  input.destroy();
});

test('the prompt in force is the injected one, and the process default otherwise', () => {
  // The seam's choice, observed without being made. `defaultPrompt` reads the
  // real stdin, so the fallback is reachable as an identity and never as a call
  // — which is the whole reason `promptOf` is a function of its own.
  const injected = (): Promise<string> => Promise.resolve('the-code');
  assert.equal(promptOf({ prompt: injected }), injected);
  assert.equal(promptOf({}), defaultPrompt);
});

test('asking goes through the prompt in force, question and answer both', async () => {
  // The call both commands make (CC-A10, CC-A11 in `login`, CC-F3 in `doctor`):
  // the question reaches the injected prompt and its line comes back unchanged.
  const asked: string[] = [];
  const answer = await ask(
    {
      prompt: (question) => {
        asked.push(question);
        return Promise.resolve('y');
      },
    },
    'Fix it now with chmod 600? [y/N] ',
  );

  assert.equal(answer, 'y');
  assert.deepEqual(asked, ['Fix it now with chmod 600? [y/N] ']);
});

test('an input that ends before a line is a rejection, not a hang', async () => {
  // EOF, Ctrl-D, `< /dev/null`: `rl.question` alone would never settle and the
  // process would exit on an unsettled await instead of reporting anything.
  const written: string[] = [];
  await assert.rejects(
    readLine('Paste the redirect: ', Readable.from([]), collectingOutput(written)),
    { message: 'The input ended before an answer was given.' },
  );
  assert.match(written.join(''), /Paste the redirect: /);
});

test('a single line followed at once by the end of input answers, not rejects', async () => {
  // The line event and the close arrive back to back; the callback form answers
  // inside the line event, before close can reject.
  const answer = await readLine(
    'Paste: ',
    Readable.from(['only\n']),
    collectingOutput([]),
  );
  assert.equal(answer, 'only');
});

test('a last line with no newline before the end of input is the answer', async () => {
  // `printf code | tiktok-mcp-ai login --manual`: readline flushes the partial
  // line at EOF as a plain `line` event that the question callback never sees.
  const answer = await readLine(
    'Paste: ',
    Readable.from(['partial']),
    collectingOutput([]),
  );
  assert.equal(answer, 'partial');
});
