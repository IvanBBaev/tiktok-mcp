# Sandbox probe runbook

How to run each open probe from [PROBE-LOG.md](PROBE-LOG.md) against a real
sandbox app, what to capture, and where the answer lands. The probe *questions*
are defined in [SYNTHESIS § 6](../reviews/round2/SYNTHESIS.md); the logging
convention is normative in [TESTING.md § Sandbox probes and the probe log](../TESTING.md#sandbox-probes-and-the-probe-log).
This file only turns each question into commands.

Nothing here runs in CI, and nothing here should be scripted into the repo: a
probe is deliberately a person at a terminal, because several of them spend
real, rate-limited budget (inits, pending shares, the active-user cap) or
invalidate the profile's tokens on purpose.

**Contents:** [0. Setup](#0-setup) · [1. Session plan](#1-session-plan) ·
[2. Read-side probes](#2-read-side-probes-p-4-p-8-p-16-p-3) ·
[3. Upload probes](#3-upload-probes-p-14-p-9-p-11-p-2-p-12-p-6) ·
[4. Long-running probes](#4-long-running-probes-p-1-p-7-p-10-p-13) ·
[5. Destructive probe](#5-destructive-probe-p-5) ·
[6. Recording a result](#6-recording-a-result)

## 0. Setup

**Accounts.** A sandbox app with Login Kit and Content Posting enabled, and at
least one **private** sandbox target-user account
([SETUP-TIKTOK-APP.md](../SETUP-TIKTOK-APP.md)). P-8 wants a second account,
P-9 an EEA account if one exists, P-10 six.

**A throwaway env file.** Probes P-3 and P-5 destroy the tokens they run on,
and every `curl` below bypasses the server's env-file lock. Never run them
against the env file a real client uses:

```sh
export TT_ENV_FILE="$PWD/.fixtures-raw/probes/.env"
mkdir -p "$(dirname "$TT_ENV_FILE")"
npx tiktok-mcp-ai login        # full scope set; writes the file above
npx tiktok-mcp-ai doctor       # every check ok before spending budget
```

`.fixtures-raw/` is gitignored; every capture below goes under
`.fixtures-raw/probes/` so a raw response — which carries `open_id`,
`log_id` and sometimes an `upload_url` — can never be staged by accident.

**Shell helpers.** Every snippet in this file is **bash** (indirect expansion,
word-splitting `${4:+…}`); from zsh, start `bash` first. Load the profile into
the shell and define the request shapes once per terminal. The access token
lives 24 h; if `doctor` reports it expired, run one read through the server (any `tiktok_get_user_info` call in
the MCP Inspector) to refresh it, then reload:

```sh
set -a; . "$TT_ENV_FILE"; set +a
API=https://open.tiktokapis.com
OUT=.fixtures-raw/probes
api() {  # api <name> <METHOD> <path> [json-body]
  curl -sS -X "$2" "$API$3" \
    -H "Authorization: Bearer $TT_ACCESS_TOKEN" \
    -H 'Content-Type: application/json; charset=UTF-8' \
    ${4:+--data "$4"} \
    -D "$OUT/$1.headers" -o "$OUT/$1.json" -w "$1 %{http_code}\n"
}
redact() {  # redact <file> — print it with the fixture placeholders applied
  sed -E 's/(upload_token=)[^&"]*/\1<UPLOAD_TOKEN>/g;
          s/(upload_id=)[^&"]*/\1<UPLOAD_ID>/g;
          s/("open_id": *")[^"]*/\1<OPEN_ID>/g;
          s/("(access|refresh)_token": *")[^"]*/\1<TOKEN>/g;
          s/("log_id": *")[^"]*/\1<LOG_ID>/g' "$1"
}
```

Paste only `redact` output into the log. Compare secrets by hash
(`printf %s "$value" | shasum -a 256 | cut -c1-12`), never by value.

**A test video.** A synthetic clip within the media constraints
([TIKTOK-API.md § 6](../TIKTOK-API.md#6-media-constraints-enforced-client-side-before-upload)),
large enough for two chunks under the planner's rules:

```sh
ffmpeg -f lavfi -i testsrc=duration=20:size=1080x1920:rate=30 \
       -f lavfi -i sine=frequency=440:duration=20 \
       -c:v libx264 -b:v 5M -pix_fmt yuv420p -c:a aac -shortest "$OUT/probe.mp4"
N=$(stat -f %z "$OUT/probe.mp4" 2>/dev/null || stat -c %s "$OUT/probe.mp4")
C=5000000; K=$(( N / C ))      # expect N ≈ 12–13 MB → K = 2
head -c "$C" "$OUT/probe.mp4" > "$OUT/c0.bin"
tail -c +$(( C + 1 )) "$OUT/probe.mp4" > "$OUT/c1.bin"   # final chunk absorbs the rest
```

If `K` is not 2, adjust `-b:v` rather than `C`: the probes below assume one
intermediate and one final chunk.

## 1. Session plan

Budgets are per user token unless noted: 6 inits/min, 30 status polls/min,
~15 posts/day per creator, 5 pending inbox shares per 24 h per creator, 5
distinct posting users per 24 h per app
([TIKTOK-API.md § 5](../TIKTOK-API.md#5-rate-limits--business-caps)). The order
below spends them once and leaves the token-destroying probes for last.

| Session | Probes | Inits spent | Ends with |
| --- | --- | --- | --- |
| A — reads | P-4, P-8, P-16 (t₀) | 0 | tokens intact |
| B — upload | P-14, P-9, P-11 + P-2, P-12, P-6 | 4–5 | P-1 and P-14 TTL clocks started |
| C — destructive | P-3, then P-5 | 1 | re-login |
| Follow-ups | P-1, P-7, P-14 TTL, P-16, P-9 | 0–1 | across days |
| Separate | P-10, P-13 | per account | needs six accounts / a verified URL prefix |

## 2. Read-side probes (P-4, P-8, P-16, P-3)

### P-4 — out-of-scope field: silent omit or error?

Log in a **second** profile without `user.info.stats`, then ask for a stats
field directly (the server would filter it out first, which is the point of
bypassing it):

```sh
TT_ENV_FILE="$OUT/.env-p4" npx tiktok-mcp-ai login --scopes user.info.basic,video.list
( set -a; . "$OUT/.env-p4"; set +a
  api p4-userinfo GET '/v2/user/info/?fields=open_id,display_name,follower_count' )
redact "$OUT/p4-userinfo.json"
```

**Record:** HTTP status, `error.code`, and whether `data.user` carries
`follower_count`, omits it, or is absent. **Lands in:**
[TIKTOK-API.md § 3.1](../TIKTOK-API.md#31-get-v2userinfofields--user-profile)
(the "working assumption" paragraph). Scope filtering in the tool layer stays
either way; only the stated reason changes.

### P-8 — Display read limit: per token or per app?

Burst one endpoint until it answers 429, first on one token, then on two tokens
of two different accounts at once. 700 requests in well under a minute crosses
the 600/min window:

```sh
seq 700 | xargs -P 20 -I{} curl -sS -o /dev/null -w '%{http_code}\n' \
  "$API/v2/user/info/?fields=open_id" -H "Authorization: Bearer $TT_ACCESS_TOKEN" \
  | sort | uniq -c > "$OUT/p8-one-token.txt"
api p8-429 GET '/v2/user/info/?fields=open_id'   # immediately: keep one 429 whole
```

Wait two minutes, then run the same command in two terminals at once, each with
the token of a different account (350 requests each). **Record:** the count of
200s before the first 429 in each run, the `p8-429` body (`redact`) and whether
its headers carry `Retry-After`. Two tokens together getting ~1200 → per token; ~600
shared → per app. **Lands in:** [TIKTOK-API.md § 5](../TIKTOK-API.md#5-rate-limits--business-caps)
(the "Dimension" column) and the read-limiter tuning note in WP-0.5.

### P-16 — `creator_info` volatility (optional tuning)

```sh
api "p16-$(date +%Y%m%dT%H%M)" POST /v2/post/publish/creator_info/query/ '{}'
```

Repeat at t₀, +1 h, +6 h, +24 h and +72 h; diff the `data` objects with
`creator_avatar_url` removed. **Record:** which fields changed and when. If
`privacy_level_options` or the `*_disabled` switches moved inside 600 s, the
plan TTL (`TT_PLAN_TTL_S`) is too long. **Lands in:** TIKTOK-API.md § 4.1.

### P-3 — refresh-token rotation grace window

**Destroys the profile's tokens — run it at the start of session C, on the
throwaway env file.** Two refreshes with the same refresh token, then a use of
each returned token:

```sh
refresh() {  # refresh <name> <refresh_token>
  curl -sS -X POST "$API/v2/oauth/token/" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "client_key=$TT_CLIENT_KEY" \
    --data-urlencode "client_secret=$TT_CLIENT_SECRET" \
    --data-urlencode grant_type=refresh_token \
    --data-urlencode "refresh_token=$2" \
    -o "$OUT/$1.json" -w "$1 %{http_code}\n"
}
R0=$TT_REFRESH_TOKEN
refresh p3-first "$R0"; refresh p3-second "$R0"          # back to back
R1=$(jq -r .refresh_token "$OUT/p3-first.json")
for r in R0 R1; do printf '%s ' $r; printf %s "${!r}" | shasum -a 256 | cut -c1-12; done
sleep 60; refresh p3-old-after-60s "$R0"
```

**Record:** both statuses, whether `R1` differs from `R0` (hashes only),
whether the second back-to-back call succeeded (that is the grace window), and
what the old token does 60 s later. If the second call succeeded, repeat with
5 s and 600 s gaps after a fresh `login` to bound the window. **Lands in:**
[TIKTOK-API.md § 2](../TIKTOK-API.md#2-oauth-20-login-kit) (the Refresh
bullet) and [AUTH.md](../AUTH.md); the refresh lock stays unless the window
is generous *and* documented (SYNTHESIS § 2.2). Finish with
`npx tiktok-mcp-ai login`.

## 3. Upload probes (P-14, P-9, P-11, P-2, P-12, P-6)

Each init below is a `SELF_ONLY` direct post: private, visible to the author
only. `creator_info` must be queried first — the audit expects it before every
direct post, and it is the cheapest check that the account is private:

```sh
api creator POST /v2/post/publish/creator_info/query/ '{}'
jq '.data.privacy_level_options' "$OUT/creator.json"   # must be ["SELF_ONLY"]
init() {  # init <name> [extra post_info json]
  api "$1" POST /v2/post/publish/video/init/ \
    "{\"post_info\":{\"title\":\"probe $1\",\"privacy_level\":\"SELF_ONLY\"${2:+,$2}},
      \"source_info\":{\"source\":\"FILE_UPLOAD\",\"video_size\":$N,\"chunk_size\":$C,\"total_chunk_count\":$K}}"
}
put() {  # put <name> <chunk-file> <first> <last>
  curl -sS -X PUT "$UPLOAD_URL" -H 'Content-Type: video/mp4' \
    -H "Content-Range: bytes $3-$4/$N" --data-binary "@$2" \
    -D "$OUT/$1.headers" -o "$OUT/$1.body" -w "$1 %{http_code}\n"
}
status() { api "$1" POST /v2/post/publish/status/fetch/ "{\"publish_id\":\"$PUBLISH_ID\"}"; }
```

Delete each probe post in the TikTok app once its probe is recorded.

### P-14 — `upload_url` anatomy, and P-9 — upload hosts

```sh
init p14-init
UPLOAD_URL=$(jq -r .data.upload_url "$OUT/p14-init.json")
PUBLISH_ID=$(jq -r .data.publish_id "$OUT/p14-init.json")
node -e 'const u=new URL(process.argv[1]); console.log(u.protocol, u.host, u.pathname,
  [...u.searchParams].map(([k,v])=>`${k}(${v.length})`).join(" "))' "$UPLOAD_URL"
```

**Record (P-14):** protocol, host, path, and each query parameter **name with
its value length** — never a value. **Record (P-9):** the host. Repeat the
host capture on every later init and on other days; an EEA account's host is
the most valuable single data point. **TTL:** leave this upload untouched,
then `put p14-after-61m "$OUT/c0.bin" 0 $(( C - 1 ))` 61 minutes after the
init — the expected answer is 403. **Lands in:**
[TIKTOK-API.md § 4.7](../TIKTOK-API.md#47-upload_url-and-the-egress-allowlist-normative):
a host outside the three accepted shapes is a spec edit there first, then the
allowlist; a credential parameter other than `upload_token` widens the
redaction sinks ([SECURITY.md](../SECURITY.md)).

### P-11 — raw chunk-PUT responses, and P-2 — re-PUT of an accepted range

Run on one fresh init, in this order, with a status poll after each step:

```sh
init p11-init
UPLOAD_URL=$(jq -r .data.upload_url "$OUT/p11-init.json")
PUBLISH_ID=$(jq -r .data.publish_id "$OUT/p11-init.json")
put  p11-c0        "$OUT/c0.bin" 0 $(( C - 1 ));        status p11-s1   # expect 206
put  p2-c0-again   "$OUT/c0.bin" 0 $(( C - 1 ));        status p2-s2    # P-2: 206? 416?
put  p11-c1        "$OUT/c1.bin" "$C" $(( N - 1 ));     status p11-s3   # expect 201
put  p2-c1-again   "$OUT/c1.bin" "$C" $(( N - 1 ));     status p2-s4    # P-2 on the final chunk
```

**Record (P-11):** for every PUT, the status, the full header block and the
body (`redact` both; headers carry no secret, but check for the URL echoed
back). The decisive field is the `Content-Range` on the 206 and on any 416:
`bytes 0-{X}/{N}` with `X = C - 1` means a last-byte index, `X = C` a count.
**Record (P-2):** what each re-PUT returned and whether `uploaded_bytes` in
the following status moved. A 5xx cannot be provoked on demand; if one is ever
seen in any session, keep its headers and body as the 5xx fixture.

**Lands in:** [TIKTOK-API.md § 4.8](../TIKTOK-API.md#48-chunk-put-responses-and-retry-semantics-normative)
— the "count or last-byte index" ambiguity in resume step 4 (today
`network_ambiguous`, CC-G4) collapses to one answer, and P-2 settles CC-D6
([CORNER-CASES.md](../CORNER-CASES.md)). The redacted bodies become recorded
fixtures through `npm run fixtures:sanitize`
([TESTING.md § Recorded sandbox fixtures](../TESTING.md#recorded-sandbox-fixtures)).
Both freeze the retry matrix (WP-2.4).

### P-12 — two byte-identical inits back to back

```sh
init p12-a; init p12-b
jq -r .data.publish_id "$OUT/p12-a.json" "$OUT/p12-b.json"
```

Do not upload either. **Record:** both statuses, whether the second is an
error, and whether the two `publish_id`s are equal. Poll both after an hour
(`PUBLISH_ID=… status p12-a-1h`) to see how an abandoned init ends.
**Lands in:** TIKTOK-API.md § 4.2 ("Retry discipline") and the
`send_ambiguous` recovery text in [TOOLS.md](../TOOLS.md) § 3.0 — inits stay
never-retried regardless; only the guidance changes.

### P-6 — `brand_content_toggle` + `SELF_ONLY` at the API

The server rejects this combination locally, so only `curl` can ask TikTok:

```sh
init p6-init '"brand_content_toggle":true'
```

**Record:** the status and `error.code`. If the init is **accepted**, upload
both chunks and poll to a terminal state; record the final `status` and
`fail_reason`. **Lands in:** TIKTOK-API.md § 4.2 ("Branded content × private
visibility"). The local rule stays either way — it is an audit UX rule, not a
mirror of an API error — but an observed error code is added to the error map.

## 4. Long-running probes (P-1, P-7, P-10, P-13)

### P-1 — `publish_id` retention after a terminal state

Use the `publish_id` of the completed P-11 post (and P-6's if it completed):

```sh
PUBLISH_ID=…; status "p1-$(date +%Y%m%d)"
```

Poll on day 0, 1, 3, 7, 14, 30 and 60. **Record:** the last date it answered
with the terminal status and the first date it did not, with that answer's
status and `error.code`. Whether the post itself still exists (it should — this
is about the status record) is worth one line. **Lands in:**
[TIKTOK-API.md § 4.5](../TIKTOK-API.md#45-status-polling-post-v2postpublishstatusfetch)
("Retention window") and the `publish_not_found` text in TOOLS.md § 3.0
(CC-E8); the journal stays the system of record regardless.

### P-7 — inbox-draft expiry

Send one draft through the server (MCP Inspector,
`tiktok_upload_video_draft` with `$OUT/probe.mp4`, `TT_WRITE_MODE=apply`), let
it reach `SEND_TO_USER_INBOX`, and **do not open it in the app**. Check the
TikTok inbox and `tiktok_get_publish_status` daily. **Record:** the day the
draft disappears or becomes unopenable, and what status/fetch says then. This
spends one of the five pending shares for 24 h. **Lands in:** TIKTOK-API.md
§ 4.3 ("Draft TTL") and the `user_action` hint wording in TOOLS.md § 5.

### P-10 — do drafts consume the 5-users/24 h app cap?

Needs six private sandbox target users. Within one 24-hour window, send one
draft from each of users 1–5 (drafts only, no direct posts), then a direct
`SELF_ONLY` post from user 6. **Record:** whether user 6 is refused with
`reached_active_user_cap`. If the sandbox cannot hold six target users, log the
probe as inconclusive with that reason — that is a result
([PROBE-LOG.md § Rules](PROBE-LOG.md#rules)). **Lands in:** TIKTOK-API.md
§ 7 item 2 and the draft tools' error texts (WP-2.5).

### P-13 — dead photo fields per `post_mode`

Photos are `PULL_FROM_URL` only, so this needs a prefix verified in the
developer portal ([TIKTOK-API.md § 4.9](../TIKTOK-API.md#49-pull_from_url-domain-verification-workflow))
hosting two JPEGs:

```sh
P='"source_info":{"source":"PULL_FROM_URL","photo_images":["https://<verified-prefix>/a.jpg","https://<verified-prefix>/b.jpg"],"photo_cover_index":0}'
api p13-draft POST /v2/post/publish/content/init/ \
  "{\"media_type\":\"PHOTO\",\"post_mode\":\"MEDIA_UPLOAD\",\"post_info\":{\"title\":\"P13 title\",\"description\":\"P13 description\"},$P}"
api p13-direct POST /v2/post/publish/content/init/ \
  "{\"media_type\":\"PHOTO\",\"post_mode\":\"DIRECT_POST\",\"post_info\":{\"title\":\"P13 direct\",\"privacy_level\":\"SELF_ONLY\",\"auto_add_music\":true},$P}"
```

**Record:** whether the draft opens in the app with the title and description
pre-filled, and whether the direct post carries music. **Lands in:**
[TOOLS.md § 3.11 and § 3.12](../TOOLS.md) — a dead field is dropped from the
schema or documented as ignored; the tool schemas freeze after this probe.

## 5. Destructive probe (P-5)

### P-5 — revoke mid-upload

Last of session C: it ends with the token revoked.

```sh
init p5-init
UPLOAD_URL=$(jq -r .data.upload_url "$OUT/p5-init.json")
PUBLISH_ID=$(jq -r .data.publish_id "$OUT/p5-init.json")
put p5-c0 "$OUT/c0.bin" 0 $(( C - 1 ))
curl -sS -X POST "$API/v2/oauth/revoke/" -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "client_key=$TT_CLIENT_KEY" --data-urlencode "client_secret=$TT_CLIENT_SECRET" \
  --data-urlencode "token=$TT_ACCESS_TOKEN" -w 'revoke %{http_code}\n'
put p5-c1 "$OUT/c1.bin" "$C" $(( N - 1 ))   # PUTs carry no bearer: does it still land?
status p5-s-revoked                          # expect 401
npx tiktok-mcp-ai login; set -a; . "$TT_ENV_FILE"; set +a
status p5-s-relogin                          # the old task, seen with a new token
```

**Record:** the final PUT's status, the revoked-token status call
(`error.code`), and what the re-logged-in status call reports for the task —
`FAILED` + `auth_removed`, a completed post, or not found. **Lands in:**
TIKTOK-API.md § 4.8 (the P-5 sentence) and the `auth_removed` row of the
`fail_reason` table in § 4.5.

## 6. Recording a result

1. Append the entry to [PROBE-LOG.md](PROBE-LOG.md) under `## Entries` using
   its template, with `redact` output only, and flip the probe's row in the
   index to `run YYYY-MM-DD`. An inconclusive run is recorded the same way.
2. If the answer contradicts the spec, the spec edit is a **separate change**
   citing the probe number ([CONTRACTS.md § Change log](../CONTRACTS.md)) —
   never folded into the log entry.
3. Raw captures stay in `.fixtures-raw/probes/`; delete them once the entry
   and any fixtures are committed.
