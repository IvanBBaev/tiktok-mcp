# Troubleshooting

Start with `doctor`. It answers most questions in one run, and its output is
safe to paste into an issue — no secret can reach it.

**Contents:** [Run doctor first](#run-doctor-first) ·
[What each check means](#what-each-check-means) ·
[Setup and startup](#setup-and-startup) · [Login and tokens](#login-and-tokens) ·
[Scopes and unavailable tools](#scopes-and-unavailable-tools) ·
[The env file and its lock](#the-env-file-and-its-lock) ·
[Rate limits and caps](#rate-limits-and-caps) ·
[Publishing](#publishing) · [Uninstall and data removal](#uninstall-and-data-removal) ·
[Still stuck](#still-stuck)

## Run doctor first

```bash
npx tiktok-mcp-ai doctor
```

From a clone, that is `node build/src/index.js doctor`.

| Option | Effect |
| ------ | ------ |
| `--profile <name>` | Check that profile instead of `TT_ACTIVE_PROFILE` (default `DEFAULT`) |
| `--offline` | Skip the live TikTok probe and run the local checks only |
| `--json` | Print the whole report as one JSON document instead of rows |
| `-h`, `--help` | Show the usage text |

| Exit code | Meaning |
| --------- | ------- |
| `0` | Healthy — warnings are allowed |
| `1` | A check failed, or the configuration could not be read at all |
| `2` | Usage error (an unknown option) |

Every row is `[ ok ]`, `[info]`, `[warn]` or `[FAIL]`, followed by the check
name and what it found. A row that has a fix carries it on the next line behind
an arrow:

```
[FAIL] tokens: profile DEFAULT has no stored token — it has never completed a login
       → npx tiktok-mcp-ai login --profile DEFAULT
```

The run ends with a tally (`… checks passed, … informational, … warnings, …
failures`). Only failures change the exit code. One broken check never stops the
report: it becomes a row like any other and the remaining checks still run.

### `--json` for scripts and CI

`--json` prints one JSON document on stdout and nothing else — no header, no
rows, no tally. The exit code is the same as without the flag.

```bash
npx tiktok-mcp-ai doctor --offline --json
```

```json
{
  "schema": "tiktok-mcp-ai/doctor-report",
  "version": 1,
  "profile": "DEFAULT",
  "offline": true,
  "checks": [
    {
      "id": "permissions",
      "title": "permissions",
      "findings": [
        {
          "severity": "warn",
          "text": "mode 0644 — this file holds refresh tokens and is readable by other accounts on this machine",
          "remediation": "chmod 600 \"/home/you/.config/tiktok-mcp-ai/.env\""
        }
      ]
    }
  ],
  "tally": { "ok": 12, "info": 2, "warn": 1, "fail": 0 },
  "exit_code": 0
}
```

| Field | What it holds |
| ----- | ------------- |
| `schema`, `version` | Identify the document. `version` rises only when a field changes meaning or disappears; a **new** field is not a version bump, so ignore what you do not recognize. |
| `profile` | The profile the run reported on — `null` when the configuration could not be read at all. |
| `offline` | Whether the live probe was skipped. |
| `checks` | One entry per check, in the same order as the rows, each with its stable `id`, its `title` and its `findings`. A check that had nothing to report is present with an empty `findings` array. |
| `findings[].severity` | `ok`, `info`, `warn` or `fail`. |
| `findings[].text` | The same sentence the row carries. |
| `findings[].remediation` | Present only when there is a fix; it is the text behind the arrow. |
| `tally` | Count per severity across the whole report. |
| `exit_code` | The exit code this document belongs to — `tally.fail > 0` is the only thing that makes it non-zero. |

Two paths do not print a document: a usage error (message on stderr, exit `2`)
and `--help`. A run whose configuration could not be read **does** print one, with
the reason as the single finding of a `configuration` check, so a consumer never
has to interpret an empty stdout.

Nothing in the document is timestamped, so two runs of the same configuration
produce identical bytes — diff them in CI. `--json` also implies
non-interactive: the permissions check reports the mode instead of offering to
fix it, since a script cannot answer the prompt.

## What each check means

The checks run in this order. Reading them top to bottom is reading the startup
path of the server.

| Check | What it is telling you |
| ----- | ---------------------- |
| `env file` | Where the env file is, or that there is none and configuration comes from the process environment only. Warnings here are parse problems: duplicate keys, unknown `TT_*` keys. |
| `permissions` | POSIX mode of the env file. Anything but `0600` is a warning, and on a terminal `doctor` offers to `chmod` it. On Windows it is an info row with the optional `icacls` command as text — the server never runs it. |
| `config schema` | The env-file layout version, plus any `.pre-schema<N>` backup left behind by a migration (they hold old credentials — delete them once you no longer need them). |
| `settings` | Every bad `TT_*` variable at once, or the effective write mode, log level and enabled packages. |
| `env lock` | Whether `<envfile>.lock` is held right now, and whether it is stale. |
| `app credentials` | Whether `TT_CLIENT_KEY` and `TT_CLIENT_SECRET` are set. |
| `profiles` | Which profiles exist and which one is active. |
| `tokens` | `open_id` (masked), refresh-token expiry, access-token expiry. An expired refresh token is a failure; an expired access token is an info row, because renewing it is routine. |
| `scopes` | Granted scopes, and which tools of the enabled packages stay unusable without which scope. |
| `api probe` | One live `user/info` call. An auth rejection fails the run; a network problem is only a warning, because a flaky link is not a broken install. Skipped with `--offline`, and skipped when the profile has not granted `user.info.basic`. |
| `media root` | Whether `TT_MEDIA_ROOT` points at a readable directory. Unset is an info row: file uploads simply stay disabled. |
| `publish journal` | Whether a journal file exists beside the env file, and its size. |
| `transport` | The configured transport. |
| `install` | Whether this copy is running from the npx cache. It warns if it is, because npx keeps its own copy and will not fetch a newer release while that copy is there — and `npm cache clean` does not remove it. The row carries the cache path for your platform. |

## Setup and startup

| Symptom | What it means | Fix |
| ------- | ------------- | --- |
| `tiktok-mcp-ai requires Node.js 22 or newer; this is …` | The version guard in the launcher. Nothing from the app was even loaded. | Install Node 22+ (`.nvmrc` pins 24). In a GUI client, point `command` at the absolute path of the new interpreter. |
| The client reports "command not found" / "server failed to start" | The client cannot resolve `node`, `npx` or the entry file. GUI clients do not inherit your shell `PATH`. | Use absolute paths in the client config — see [docs/CLIENTS.md](CLIENTS.md). |
| `doctor` says `missing TikTok app credentials: …` (`missing_credentials`) | `TT_CLIENT_KEY` and/or `TT_CLIENT_SECRET` are not set anywhere the process can see. | Put both in the env file, or in the client's `env` block. Restart the client afterwards. |
| Tools appear but every call fails with `unknown_account '<name>'` | The `account` argument names a profile that does not exist; the error lists the ones that do. | Drop the argument to use the default profile, or run `login --profile <name>` first. |
| No tools at all in the client | `TT_TOOL_PACKAGES` / `TT_PACKAGES_DENY` left nothing enabled; `doctor`'s `settings` row says so. | Widen `TT_TOOL_PACKAGES` (default `core`) or shorten `TT_PACKAGES_DENY`. |
| A bug the release notes say is fixed is still there, and `doctor` warns `running from the npx cache` | `npx` re-runs its own cached copy of the package and does not fetch a newer release while that copy is there. `npm cache clean` does **not** remove it. | Delete the cache, then re-run: `rm -rf ~/.npm/_npx` (macOS/Linux) or `rd /s /q "%LOCALAPPDATA%\npm-cache\_npx"` (Windows). `npx tiktok-mcp-ai@latest` pins the fetch. |

## Login and tokens

| Symptom | What it means | Fix |
| ------- | ------------- | --- |
| TikTok's own screen rejects the login before the browser comes back | The `redirect_uri` this server sent is not registered on the app — usually the missing trailing slash, `localhost` instead of `127.0.0.1`, or a registration without a wildcard port. | Register `http://127.0.0.1:*/callback/` exactly ([docs/SETUP-TIKTOK-APP.md § 3](SETUP-TIKTOK-APP.md#3-register-the-redirect-uri)). |
| `login` fails naming `TT_REDIRECT_PORT` | You pinned a port and something else is on it. It never silently moves to an unregistered shape. | Free the port, change the pin (and the registration), or run `login --manual`. |
| `login` hangs with no browser | Headless or SSH session. | `login --no-browser` prints the URL; `login --manual` also skips the loopback listener and takes the redirect URL by paste. |
| A tool fails with `auth_expired` | TikTok rejected the token and the automatic refresh could not fix it — the refresh token expired (365 days), was revoked in the TikTok app, or the app's secret changed. Not retryable. | `npx tiktok-mcp-ai login --profile <name>`. Do not retry the call until that finishes. |
| `doctor` says `the refresh token expired … ; this server cannot renew it on its own` | Same condition, caught locally before any call. | Same: log in again. |
| `doctor` warns `the refresh token expires …` | It has less than 30 days left. Everything works today. | Re-run `login` before the date given. |
| `doctor` says `the access token expired …` as an **info** row | Expected. The 24-hour access token is renewed on the next call from the refresh token. | Nothing. |
| Tokens work in the terminal but not in the client | The client is a different process with a different environment — usually a different `HOME`, `XDG_CONFIG_HOME` or `TT_ENV_FILE`, so it reads a different env file. | Compare `doctor`'s `env file` row with the path the client uses; pin `TT_ENV_FILE` in the client config if they differ. |

## Scopes and unavailable tools

A tool whose description starts with

```
[UNAVAILABLE: requires scope video.publish; no configured profile grants it. Fix: npx tiktok-mcp-ai login --scopes video.publish]
```

is registered but not authorized by any profile. The marker is advisory — it is
computed at listing time from the union over all profiles, and the tool stays
callable, because hiding it would strand clients that cache tool lists.

The authoritative check happens on the call, against the profile the call
resolves to. That is where you get:

```
Account 'DEFAULT' was authorized without scope video.publish, which this tool requires.
Ask the user to run: npx tiktok-mcp-ai login --profile DEFAULT --scopes video.publish —
then verify with tiktok_get_auth_status.
```

(error code `missing_scope`). Consequences worth knowing:

- A marker can be stale in either direction on a multi-account setup: the union
  may look fine while the *chosen* profile is not, and a stale marker never
  blocks a call that would now succeed.
- The list is recomputed on every `tools/list`, so a `login` you ran in another
  terminal is picked up the next time the client asks for the tool list. A
  client that caches its tool list needs a restart to see the change.
- `doctor`'s `scopes` row lists exactly which tools stay unusable and prints the
  `login --scopes …` command that fixes it, with the already-granted scopes
  included so you do not lose any.
- Scopes must also be enabled on the app in the developer portal. If the
  authorization screen refuses a scope, the app is the gate, not this server.

## The env file and its lock

The server writes the env file atomically under a cross-process lock: a
directory named `<envfile>.lock` beside it, kept alive by a heartbeat.

| Symptom | What it means | Fix |
| ------- | ------------- | --- |
| A call fails with `env_file_busy` | Another `tiktok-mcp-ai` process held the lock longer than `TT_ENV_LOCK_WAIT_MS` (30 s default). Retryable. | Wait a few seconds and retry. If nothing else is running, `doctor`'s `env lock` row reports the stale lock and prints the `rm -rf <envfile>.lock` command. |
| `doctor` warns about a stale lock | A writer crashed. The next writer breaks a stale lock by itself, so this is a report, not a repair. | Nothing, usually. Remove the directory only if nothing is writing. |
| `env_file_malformed`: `line N is not a comment and not a KEY=value assignment` | A hand-edit broke the file. Values may not span lines; comments start with `#` on their own line. | Fix or remove that line. |
| `doctor` warns about duplicate or unknown `TT_*` keys | The file parses, but a key is set twice (last one wins) or misspelled — a misspelled key is silently inert, which is exactly how a setting "does not work". | Correct the file; [.env.example](../.env.example) lists every valid key. |
| `config_schema_too_new`: writes refused | The env file was written by a newer version of this tool. Reads still work; writes are refused so an older build cannot corrupt a newer layout. | Update the package. |
| `doctor` mentions leftover `.pre-schema<N>` backups | A migration kept a copy of the pre-migration file. It contains credentials. | Delete it once you are sure you do not need it. |
| `permissions: mode 0644 …` | The env file is readable by other accounts on the machine, and it holds refresh tokens. | `chmod 600 <envfile>` — on a terminal `doctor` offers to do it for you. |

## Rate limits and caps

Not all of these are the same problem, and the difference decides whether
retrying is sane.

| Code | Where it comes from | What to do |
| ---- | ------------------- | ---------- |
| `local_rate_limited` | This server's own token bucket for publish inits: 6 per profile, refilling one every 10 seconds. Rejected locally, zero network. The error carries `retry_after_s` and an absolute `retry_at`. | Wait until `retry_at`. A preview never consumes a token and never refuses, so you can still prepare the post. |
| `rate_limited` | TikTok answered 429. On a publish init this is **terminal for that attempt** — the init is never retried automatically, because a blind retry risks a duplicate post. | Wait the interval the error names, then start a fresh preview/apply. |
| `daily_post_cap` | Upstream `spam_risk_too_many_posts`: the account hit its daily posting limit (~15 posts/24 h, shared across every app posting via the API). | Do not retry today. It clears as the 24 h window rolls. |
| `active_user_cap` | Upstream `reached_active_user_cap`: an unaudited app served its maximum of 5 posting users in 24 h. | Do not retry today. The permanent fix is passing TikTok's app audit. |
| `pending_share_cap` | Upstream `spam_risk_too_many_pending_share`: 5 unpublished API drafts already waiting on the account. | The user opens TikTok's inbox notifications and publishes or discards the pending drafts. |

Read calls have their own upstream budgets (documented in
[docs/TIKTOK-API.md § 5](TIKTOK-API.md#5-rate-limits--business-caps)); the server
retries the retryable ones on its own.

## Publishing

**A publish that seems stuck is normal.** A write tool returns a `publish_id`
immediately and TikTok processes the media afterwards. `tiktok_get_publish_status`
polls internally on a backoff schedule (2 s, then 5 s, then every 10 s) for up to
about 60 seconds (`TT_STATUS_POLL_TIMEOUT_MS`).

| Status | Meaning |
| ------ | ------- |
| `PROCESSING_DOWNLOAD` | TikTok is pulling the media from your URL |
| `PROCESSING_UPLOAD` | TikTok is checking the file you uploaded |
| `SEND_TO_USER_INBOX` | A draft was delivered. **The user must open the TikTok app notification to finish it** — nothing more happens server-side |
| `PUBLISH_COMPLETE` | Live. `public_post_id` is present when TikTok exposes it |
| `FAILED` | The result carries `fail_reason` and a matching `fail_recovery` text |

A poll timeout is **not** a failure: the call returns `ok: true` with the last
observed status and a fresh `poll` hint. Call `tiktok_get_publish_status` again
with the same `publish_id`. **Never re-run a posting tool because processing is
slow** — that creates a second post.

| Code | What it means | What to do |
| ---- | ------------- | ---------- |
| `plan_not_found` | The `plan_id` is unknown, already used, or expired (single-use, `TT_PLAN_TTL_S`, 10 min default). | Call the tool again *without* `plan_id`, show the fresh preview, then apply. |
| `plan_mismatch` | The arguments, the account, or the file on disk changed since the preview. A plan applies exactly the previewed payload — including the file's size, mtime and identity. | Preview again and apply the new `plan_id`. |
| `possible_duplicate` | The journal already holds an attempt with an identical payload — same media, text and settings — on this account. The guard matches the whole resolved request, not any single field, so editing the caption is not a way past it: it produces a *different* payload, which posts. | Verify with `tiktok_get_publish_status` and `tiktok_list_publish_journal` that no post exists. Only then re-preview and apply with `force: true`. |
| `media_root_not_configured` | `TT_MEDIA_ROOT` is unset (file uploads are fail-closed) or points somewhere unreadable. | Set it to a dedicated directory — never `$HOME` — and restart the client. |
| `file_outside_media_root` | The path resolves outside `TT_MEDIA_ROOT` after `realpath`, so a symlink out of the tree is caught too. | Move the file under the media root. |
| `file_not_found`, `file_empty`, `file_too_large` | Local pre-flight, before any byte leaves the machine. | Fix the file. Size limits are in [docs/TIKTOK-API.md § 6](TIKTOK-API.md). |
| `url_prefix_unverified` | Either the local prefix allow-list or TikTok itself (`url_ownership_unverified`) refused the URL's host. Domain verification is a platform rule, not a server setting. | Host the media under a verified domain ([§ 8](SETUP-TIKTOK-APP.md#8-verify-a-domain-for-url-posting)), or upload a local file instead. |
| `privacy_level_unavailable` | The requested privacy level is not among the ones `creator_info` offered — typically an unaudited app, where only `SELF_ONLY` exists. | Use one of the offered levels. The audit gate is TikTok's, and this server does not work around it. |
| `branded_content_privacy_conflict` | TikTok forbids that combination of branded-content flags and privacy level. | Change one of the two. |
| `upload_interrupted` | Chunks failed after the automatic retries, or all chunks were accepted and TikTok never confirmed. The upload cannot be resumed. | Check `tiktok_get_publish_status` for that `publish_id` first. If the post is genuinely missing, a fresh preview + apply creates a **new** attempt. |
| `network_unsent` | The request provably never left the machine. Safe to retry. | Retry. |
| `network_ambiguous` | The connection broke after the request may have been sent. **Not** safe to retry blindly. | Check `tiktok_list_publish_journal` and `tiktok_get_publish_status`, then decide. |
| `publish_not_found` | TikTok has no record of that `publish_id` — expired status window, or another app's id. | Look for the attempt in `tiktok_list_publish_journal` and for the result in `tiktok_list_videos`. |
| `journal_unreadable` | The local journal file exists but cannot be read or parsed. | Check permissions on `journal.ndjson` beside the env file. Publishing keeps working; only the journal read fails. |

## Uninstall and data removal

This server keeps no database. Everything it writes lives beside the resolved
env file — `~/.config/tiktok-mcp-ai/` on macOS/Linux,
`%LOCALAPPDATA%\tiktok-mcp-ai\` on Windows, or the directory of `TT_ENV_FILE`
if you set it. `doctor` prints the exact paths in its `env file` and
`publish journal` rows.

| File | What it holds |
| ---- | ------------- |
| `.env` | Client key, client secret, access and refresh tokens, your `TT_*` settings |
| `journal.ndjson` (+ `journal.ndjson.1`) | Append-only record of publish attempts: timestamp, profile, `open_id`, tool, title excerpt, `publish_id`, outcome. No media, no tokens |
| `.env.lock` | The cross-process write lock. Transient — present only while a write is in flight, or left behind by a crash |
| `.env.pre-schema<N>` | Backup written by a schema migration. Holds credentials |

Removing everything, in the order that leaves nothing behind:

1. **Revoke on the TikTok side.** For each profile:

   ```bash
   npx tiktok-mcp-ai login --revoke --profile DEFAULT
   ```

   This asks TikTok to revoke the token and clears it from the env file. The
   publish journal is deliberately kept; add `--purge-journal` to delete it in
   the same step.
2. **Revoke in the TikTok app as well** if you want to be certain — TikTok's
   account settings list the apps a user has authorized, and removing the entry
   there is independent of anything this server can do.
3. **Delete the local state.**

   ```bash
   rm -rf ~/.config/tiktok-mcp-ai
   ```

   On Windows, delete `%LOCALAPPDATA%\tiktok-mcp-ai`. If you set `TT_ENV_FILE`,
   delete that file plus the `journal.ndjson*`, `*.lock` and `*.pre-schema*`
   siblings in its directory.
4. **Remove the client entry** — the `mcpServers` (or `servers`) block you added
   in [docs/CLIENTS.md](CLIENTS.md), the Claude Code plugin, or the VS Code
   extension.
5. **Remove the code**: `npm uninstall -g tiktok-mcp-ai` if you installed it
   globally, delete the clone, and clear the npx cache entry if you used `npx` —
   `rm -rf ~/.npm/_npx` on macOS/Linux,
   `rd /s /q "%LOCALAPPDATA%\npm-cache\_npx"` on Windows. `npm cache clean` does
   not touch that directory, and it holds a copy of every package you have ever
   run with `npx`, not only this one.
6. **Optionally delete the developer app** in the TikTok portal. That is the only
   step that also removes the app-side record of the integration.

Nothing else on the machine is touched: no system services, no login items, no
files outside the directory above.

## Still stuck

Open an issue with the output of `npx tiktok-mcp-ai doctor` attached —
[CONTRIBUTING.md § Reporting a bug](../CONTRIBUTING.md#reporting-a-bug) explains
what to include and why the `doctor` output is safe to paste.
