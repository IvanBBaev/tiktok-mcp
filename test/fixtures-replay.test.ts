/**
 * Recorded-fixture replay (TESTING.md § Recorded sandbox fixtures).
 *
 * A fixture is a recorded round trip with a real sandbox account, and replaying
 * it is a contract test in two directions at once: the recorded *response* goes
 * back through the `api/` parsers ("TikTok's envelope drifted") and the request
 * our client produces is compared against the recorded *request* ("our payload
 * drifted"). Neither half is worth much alone — a parser that accepts anything
 * passes the first, and a client that sends the right shape to the wrong
 * endpoint passes the second.
 *
 * The suite has four parts, and the first one is why the other three can be
 * trusted:
 *
 * - **A. Self-proof.** `test/fixtures/recorded/` is empty until someone runs
 *   `npm run fixtures:record` against a sandbox account, and a suite whose only
 *   evidence is "zero fixtures, zero failures" cannot fail. So the harness is
 *   first driven with synthetic fixtures, in both directions: it accepts a
 *   correct replay, and it *rejects* each specific drift it exists to catch.
 * - **B. The committed tree.** Every recorded fixture round-trips through the
 *   format and replays with no drift. When the tree is empty this says so, out
 *   loud, and asserts that section A really ran.
 * - **C. Secrets.** No fixture file may carry a secret-shaped value — plus a
 *   non-vacuity check, because a scanner that matches nothing also reports a
 *   clean tree.
 * - **D. Staleness.** Advisory only: a recording older than
 *   `STALE_AFTER_DAYS` warns and never fails. Failing the build on the calendar
 *   would turn a suite red without a line of code changing.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { inspect } from 'node:util';

import {
  ageInDays,
  findSecretShapes,
  FIXTURE_ROOT,
  isStale,
  loadFixtures,
  parseFixture,
  renderFixture,
  STALE_AFTER_DAYS,
  walkFixtureTree,
  type Fixture,
} from '../scripts/lib/fixtures.js';
import { readRepoText, repoPath } from '../scripts/lib/repo.js';
import { TikTokError } from '../src/core/errors.js';
import {
  compareRequest,
  describeFixture,
  envelopeBody,
  NON_REPLAYABLE_AREAS,
  nonReplayableReason,
  renderMismatches,
  replayFixture,
  REPLAY_ACCESS_TOKEN,
  REPLAY_ORIGIN,
  routedEndpoints,
  syntheticFixture,
  type SyntheticOverrides,
} from './harness/fixtures.js';
import { type RecordedCall } from './helpers.js';

// ---------------------------------------------------------------------------
// A. self-proof — the harness accepts a clean replay and rejects each drift
// ---------------------------------------------------------------------------

/**
 * How many section-A tests must have run before section B may call the tree
 * verified. Node's test runner executes top-level tests in declaration order,
 * so section B can read this counter and refuse to be silently vacuous.
 */
const SELF_TESTS = 10;
let selfTestsRun = 0;

/** A recorded `POST /v2/video/list/`, sanitized the way a real one would be. */
function videoListFixture(overrides: SyntheticOverrides = {}): Fixture {
  return syntheticFixture({
    area: 'video',
    name: 'synthetic-video-list',
    method: 'POST',
    path: '/v2/video/list/',
    url: `${REPLAY_ORIGIN}/v2/video/list/?fields=id,title`,
    requestBody: { max_count: 10, cursor: 1_700_000_000_000 },
    responseBody: envelopeBody({
      videos: [{ id: 'v1', title: 'A' }],
      cursor: 1_700_000_000_000,
      has_more: true,
    }),
    ...overrides,
  });
}

/**
 * A `RecordedCall` assembled by hand, for the two comparison rules no routed
 * endpoint can demonstrate on its own: our client never sends a boolean in a
 * read request. Everything except the body matches the fixture, so a mismatch
 * can only come from the body.
 */
function callWithBody(fixture: Fixture, body: unknown): RecordedCall {
  const text = JSON.stringify(body);
  return {
    url: fixture.request.url,
    method: fixture.endpoint.method,
    headers: {
      ...fixture.request.headers,
      authorization: `Bearer ${REPLAY_ACCESS_TOKEN}`,
    },
    body: text,
    text: () => text,
    json: () => JSON.parse(text) as unknown,
  };
}

test('replay: a synthetic fixture round-trips in both directions', async () => {
  const fixture = syntheticFixture();
  const outcome = await replayFixture(fixture);

  // Response direction: the recorded envelope went through the real parser.
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.value, {
    open_id: 'aaaa-bbbb-cccc',
    display_name: 'Sandbox',
  });

  // Request direction: what the client produced matches what was recorded.
  assert.deepEqual(compareRequest(fixture, outcome.call), []);
  selfTestsRun += 1;
});

test('replay: a request field the client no longer sends is reported', async () => {
  // The recording carries a parameter the client has since dropped. The api
  // layer ignores it, so only the request comparison can catch it — which is
  // exactly the half a response-only fixture test would be missing.
  const fixture = videoListFixture({
    requestBody: { max_count: 10, cursor: 1_700_000_000_000, extra_flag: true },
  });
  const outcome = await replayFixture(fixture);

  assert.equal(outcome.error, undefined);
  assert.deepEqual(compareRequest(fixture, outcome.call), [
    { field: 'body.extra_flag', expected: 'boolean true', actual: '(absent)' },
  ]);
  selfTestsRun += 1;
});

test('replay: a changed number is reported even though the key structure matches', async () => {
  const outcome = await replayFixture(videoListFixture());
  const drifted = videoListFixture({
    requestBody: { max_count: 20, cursor: 1_700_000_000_000 },
  });

  assert.deepEqual(compareRequest(drifted, outcome.call), [
    { field: 'body.max_count', expected: 'number 20', actual: 'number 10' },
  ]);
  selfTestsRun += 1;
});

test('replay: a flipped flag is reported, a changed string value is not', () => {
  // A comparison input, never replayed: `post_info` belongs to a write request
  // and the point here is the rule, not the endpoint. Strings collapse to their
  // type because a sanitized fixture holds pseudonyms — comparing string values
  // would report the sanitizer's work as drift. Booleans and numbers keep their
  // value because a flipped `disable_comment` is a real, silent payload change.
  const fixture = syntheticFixture({
    area: 'publish',
    name: 'synthetic-flag-rule',
    method: 'POST',
    path: '/v2/post/publish/video/init/',
    url: `${REPLAY_ORIGIN}/v2/post/publish/video/init/`,
    requestBody: {
      publish_id: 'pub-recorded',
      post_info: { disable_comment: false, title: 'recorded title' },
    },
  });
  const call = callWithBody(fixture, {
    publish_id: 'pub-produced',
    post_info: { disable_comment: true, title: 'produced title' },
  });

  assert.deepEqual(compareRequest(fixture, call), [
    {
      field: 'body.post_info.disable_comment',
      expected: 'boolean false',
      actual: 'boolean true',
    },
  ]);
  selfTestsRun += 1;
});

test('replay: a changed method is reported', async () => {
  const outcome = await replayFixture(syntheticFixture());

  assert.deepEqual(compareRequest(syntheticFixture({ method: 'POST' }), outcome.call), [
    { field: 'method', expected: 'POST', actual: 'GET' },
  ]);
  selfTestsRun += 1;
});

test('replay: a changed path is reported', async () => {
  const outcome = await replayFixture(syntheticFixture());
  // Deliberately inconsistent — `request.url` moves while `endpoint.path` stays
  // put, which `parseFixture` would reject for a committed fixture. It is built
  // in memory precisely because no *valid* fixture can express this drift: the
  // router dispatches on `endpoint.path`, so moving that makes the fixture
  // unrouted (the test below) rather than mismatched.
  const drifted = syntheticFixture({
    url: `${REPLAY_ORIGIN}/v2/user/profile/?fields=open_id,display_name`,
  });

  assert.deepEqual(compareRequest(drifted, outcome.call), [
    { field: 'path', expected: '/v2/user/profile/', actual: '/v2/user/info/' },
  ]);
  selfTestsRun += 1;
});

test('replay: a recorded error envelope makes the api function reject (CC-B1)', async () => {
  // HTTP 200 with a non-`ok` code is TikTok's canonical failure shape. A parser
  // that read `data` without checking `error.code` would return `undefined`
  // here and this test is what stops that from ever being green.
  const fixture = syntheticFixture({
    name: 'synthetic-user-info-error',
    responseBody: envelopeBody(null, {
      code: 'scope_not_authorized',
      message: 'The scope is not authorized',
    }),
  });
  const outcome = await replayFixture(fixture);

  assert.equal(outcome.value, undefined);
  assert.ok(outcome.error instanceof TikTokError);
  assert.equal(outcome.error.kind, 'api');
  assert.equal(outcome.error.apiCode, 'scope_not_authorized');
  // The request half still holds: a failing response is not a broken request.
  assert.deepEqual(compareRequest(fixture, outcome.call), []);
  selfTestsRun += 1;
});

test('replay: an endpoint nobody routes fails loudly, naming the path', async () => {
  // A *replayable* area with a path no route covers. That distinction is the
  // whole point of the test: this is the case that must never degrade into a
  // skip, because a recorded interaction nobody replays looks exactly like a
  // verified one.
  const fixture = syntheticFixture({
    area: 'video',
    name: 'synthetic-unrouted',
    method: 'POST',
    path: '/v2/video/comment/list/',
    url: `${REPLAY_ORIGIN}/v2/video/comment/list/`,
    requestBody: { video_id: 'v1' },
  });

  await assert.rejects(
    () => replayFixture(fixture),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /no replay route/);
      assert.match(error.message, /\/v2\/video\/comment\/list\//);
      // The failure also says where to add the route.
      assert.match(error.message, /test\/harness\/fixtures\.ts/);
      return true;
    },
  );
  selfTestsRun += 1;
});

test('replay: a non-replayable area is exempt by name, not by accident', async () => {
  const fixture = syntheticFixture({
    area: 'auth',
    name: 'synthetic-token-refresh',
    method: 'POST',
    path: '/v2/oauth/token/',
    url: `${REPLAY_ORIGIN}/v2/oauth/token/`,
    requestBody: 'grant_type=refresh_token&refresh_token=REDACTED',
  });

  // `auth` and `upload` are recorded (the recorder writes a token refresh the
  // moment one happens) but cannot be driven through an `api/` function. The
  // exemption is a named list with a reason, so the skip is auditable — and
  // asking for the replay anyway still throws, naming the reason and the way
  // out.
  const reason = nonReplayableReason(fixture);
  assert.ok(reason !== undefined, 'auth must be exempt from the replay contract');
  assert.match(reason, /oauth/i);
  assert.equal(nonReplayableReason(videoListFixture()), undefined);
  assert.deepEqual([...NON_REPLAYABLE_AREAS.keys()].sort(), ['auth', 'upload']);

  await assert.rejects(
    () => replayFixture(fixture),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /not replayable/);
      assert.match(error.message, /nonReplayableReason/);
      return true;
    },
  );
  selfTestsRun += 1;
});

test('replay: every routed endpoint replays cleanly', async () => {
  const fixtures: Fixture[] = [
    syntheticFixture(),
    videoListFixture(),
    syntheticFixture({
      area: 'video',
      name: 'synthetic-video-query',
      method: 'POST',
      path: '/v2/video/query/',
      url: `${REPLAY_ORIGIN}/v2/video/query/?fields=id,title`,
      requestBody: { filters: { video_ids: ['v1', 'v2'] } },
      responseBody: envelopeBody({
        videos: [
          { id: 'v1', title: 'A' },
          { id: 'v2', title: 'B' },
        ],
      }),
    }),
    syntheticFixture({
      area: 'publish',
      name: 'synthetic-creator-info',
      method: 'POST',
      path: '/v2/post/publish/creator_info/query/',
      // No `fields` at all — the Content Posting API does not take one, and a
      // replay that invented one would be drift the comparison must report.
      url: `${REPLAY_ORIGIN}/v2/post/publish/creator_info/query/`,
      requestBody: {},
      responseBody: envelopeBody({
        creator_nickname: 'Sandbox',
        creator_username: 'sandbox',
        privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
        comment_disabled: false,
        duet_disabled: false,
        stitch_disabled: false,
        max_video_post_duration_sec: 600,
      }),
    }),
    syntheticFixture({
      area: 'publish',
      name: 'synthetic-publish-status',
      method: 'POST',
      path: '/v2/post/publish/status/fetch/',
      url: `${REPLAY_ORIGIN}/v2/post/publish/status/fetch/`,
      requestBody: { publish_id: 'pub-1' },
      responseBody: envelopeBody({ status: 'PUBLISH_COMPLETE' }),
    }),
  ];

  for (const fixture of fixtures) {
    const outcome = await replayFixture(fixture);
    assert.equal(outcome.error, undefined, `${describeFixture(fixture)} rejected`);
    const mismatches = compareRequest(fixture, outcome.call);
    assert.deepEqual(
      mismatches,
      [],
      `${describeFixture(fixture)} drifted:\n${renderMismatches(mismatches)}`,
    );
  }

  // The router table and this coverage list are kept honest against each other:
  // adding a route without a synthetic replay for it fails here.
  const covered = fixtures.map((f) => `${f.area} ${f.endpoint.path}`).sort();
  assert.deepEqual(covered, routedEndpoints());
  selfTestsRun += 1;
});

// ---------------------------------------------------------------------------
// B. the committed tree
// ---------------------------------------------------------------------------

test('fixtures: every recorded fixture round-trips through the format', async () => {
  for (const { file } of await loadFixtures()) {
    const text = await readRepoText(file);
    // Render(parse(x)) === x is what makes the sanitizer's output reviewable:
    // a fixture nobody can regenerate byte-for-byte is a fixture whose diffs
    // are noise, and noisy diffs are how a re-recorded secret slips through.
    assert.equal(
      renderFixture(parseFixture(JSON.parse(text), file)),
      text,
      `${file} is not in canonical form — re-run npm run fixtures:sanitize`,
    );
  }
});

test('fixtures: every recorded fixture replays with no request drift', async () => {
  const loaded = await loadFixtures();
  const replayable = loaded.filter(
    ({ fixture }) => nonReplayableReason(fixture) === undefined,
  );

  if (replayable.length === 0) {
    // Loud on purpose. The suite still passes — an empty tree is the expected
    // state before anyone has sandbox credentials — but it must never be
    // mistaken for a verified contract, so it says what is missing and how to
    // fix it, and it proves the harness itself was exercised.
    console.warn(
      loaded.length === 0
        ? `fixtures: ${FIXTURE_ROOT}/ is empty — no recorded interaction is being ` +
            'replayed; run `npm run fixtures:record` on a sandbox account.'
        : `fixtures: all ${String(loaded.length)} recorded fixtures are in a ` +
            'non-replayable area, so nothing is being replayed; record a Display ' +
            'or publish interaction too.',
    );
    assert.equal(
      selfTestsRun,
      SELF_TESTS,
      'the replay harness self-tests did not all run, so an empty fixture tree ' +
        'proves nothing at all',
    );
    return;
  }

  for (const { file, fixture } of replayable) {
    const outcome = await replayFixture(fixture);
    const mismatches = compareRequest(fixture, outcome.call);
    assert.deepEqual(
      mismatches,
      [],
      `${file}: the request we produce no longer matches the recording:\n` +
        renderMismatches(mismatches),
    );
    // A fixture that records a failure is legitimate, so the response half only
    // asserts that the parser reached a verdict rather than crashing on shape:
    // anything other than a TikTokError is a parser that fell over, not an API
    // that said no.
    if (outcome.error !== undefined && !(outcome.error instanceof TikTokError)) {
      assert.fail(
        `${file}: replay threw something that is not a TikTokError: ` +
          inspect(outcome.error),
      );
    }
  }
});

// ---------------------------------------------------------------------------
// C. secrets
// ---------------------------------------------------------------------------

test('fixtures: no recorded fixture carries a secret-shaped value', async () => {
  // Every file under the tree, not just the `<area>/*.json` the loader reads: a
  // `.bak` from a hand-edit or an editor swapfile would be committed like any
  // other file, and a leak does not have to be well-formed to be a leak.
  for (const file of await walkFixtureTree()) {
    // Raw bytes, not the parsed object: a leak in a key, in whitespace or in a
    // member the format does not model is still a leak.
    const text = await readFile(repoPath(file), 'utf8');
    const hits = findSecretShapes(text);
    assert.deepEqual(
      hits,
      [],
      hits.map((hit) => `${file}: ${hit.shape} — ${hit.why}`).join('\n'),
    );
  }
});

test('fixtures: the secret scanner is not vacuous', () => {
  // A scanner that matches nothing reports a clean tree forever. These two are
  // invented, obviously-fake material in the exact places a real recording
  // would carry the real thing.
  const hits = findSecretShapes(
    '{"authorization":"Bearer FAKE-not-a-real-token-0000",' +
      '"url":"https://example.test/x?access_token=FAKE-not-a-real-token-0000"}',
  );
  const shapes = new Set(hits.map((hit) => hit.shape));

  assert.ok(shapes.has('bearer-token'), 'a live bearer header must be detected');
  assert.ok(shapes.has('sensitive-param'), 'a live access_token param must be detected');
  // And the sanitized spellings must stay clean, or the scanner would flag
  // every correctly sanitized fixture and get suppressed rather than fixed.
  assert.deepEqual(
    findSecretShapes(
      '{"authorization":"Bearer <ACCESS_TOKEN>","url":"https://x/?access_token=REDACTED"}',
    ),
    [],
  );
});

// ---------------------------------------------------------------------------
// D. staleness (advisory)
// ---------------------------------------------------------------------------

test('fixtures: a stale recording warns and never fails', async () => {
  const loaded = await loadFixtures();
  const nowMs = Date.now();
  let checked = 0;

  for (const { file, fixture } of loaded) {
    checked += 1;
    if (!isStale(fixture.recordedAt, nowMs)) continue;
    console.warn(
      `fixtures: ${file} was recorded ${String(ageInDays(fixture.recordedAt, nowMs))} ` +
        `days ago (over ${String(STALE_AFTER_DAYS)}) — it may be describing an API ` +
        'that has moved; re-record it when convenient.',
    );
  }

  assert.equal(checked, loaded.length);
});

test('fixtures: staleness turns over the day after STALE_AFTER_DAYS', () => {
  // Pinned against a fixed `nowMs` rather than the wall clock: an advisory
  // whose own boundary test drifts with the calendar is worse than none.
  const recordedAt = '2026-01-01T00:00:00.000Z';
  const base = Date.parse(recordedAt);
  const day = 86_400_000;

  assert.equal(ageInDays(recordedAt, base + STALE_AFTER_DAYS * day), STALE_AFTER_DAYS);
  assert.equal(isStale(recordedAt, base + STALE_AFTER_DAYS * day), false);
  assert.equal(isStale(recordedAt, base + (STALE_AFTER_DAYS + 1) * day), true);
});
