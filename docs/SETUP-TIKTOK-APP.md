# Set up a TikTok developer app

This server has no credentials of its own. It drives **your** TikTok developer
app, so before anything works you need an app at
[developers.tiktok.com](https://developers.tiktok.com), the right products
enabled on it, and one redirect URI registered.

Plan for 15 minutes for the app itself. Domain verification (only needed for
URL-based posting) and TikTok's content-sharing audit (only needed for public
posts) take longer and are covered at the end.

The portal's wording and layout change from time to time. Button names below are
what they were called when this was written; the **concepts** — app, product,
scope, redirect URI, sandbox, audit — are stable, so navigate by those.

**Contents:** [What you end up with](#what-you-end-up-with) ·
[1. Create the app](#1-create-the-app) ·
[2. Add the products](#2-add-the-products) ·
[3. Register the redirect URI](#3-register-the-redirect-uri) ·
[4. Store the client key and secret](#4-store-the-client-key-and-secret) ·
[5. Authorize an account](#5-authorize-an-account) ·
[6. Sandbox vs. production](#6-sandbox-vs-production) ·
[7. The audit gate](#7-the-audit-gate) ·
[8. Verify a domain for URL posting](#8-verify-a-domain-for-url-posting) ·
[9. Confirm it works](#9-confirm-it-works)

## What you end up with

| Thing | Where it comes from | Where it goes |
| ----- | ------------------- | ------------- |
| Client key | App page in the portal | `TT_CLIENT_KEY` in the env file |
| Client secret | App page in the portal (shown once) | `TT_CLIENT_SECRET` in the env file |
| Redirect URI | You register it on the app | Nothing to configure — `login` sends the registered shape |
| Products | You add them to the app | Nothing to configure |
| Scopes | Granted by the user during `login` | Stored with the token in the env file |

The env file is `~/.config/tiktok-mcp-ai/.env` on macOS/Linux and
`%LOCALAPPDATA%\tiktok-mcp-ai\.env` on Windows
([docs/CONFIGURATION.md](CONFIGURATION.md) has the full resolution order).

## 1. Create the app

1. Sign in to [developers.tiktok.com](https://developers.tiktok.com) with a
   TikTok account and open **Manage apps**.
2. Create an app and fill in the basic details (name, description, icon, terms
   and privacy URLs). Some of these fields are optional now and mandatory later,
   at audit time — see TikTok's
   [App review guidelines](https://developers.tiktok.com/doc/app-review-guidelines).
3. The app page shows the **client key** and **client secret**. The secret is
   shown once; if you lose it, regenerate it and update your env file.

One app can serve several TikTok accounts. You do **not** need one app per
account — multiple accounts are handled by profiles on this side
([docs/AUTH.md](AUTH.md) § Profiles).

**About the terms and privacy URLs.** The portal is asking about *your* app: who
operates it, what it does with the data it pulls from TikTok, and how a user
withdraws consent. Whatever you enter has to be a page you publish and control,
because it is the answer TikTok and your users hold *you* to.

This project publishes its own
[Privacy Policy](https://ivanbbaev.github.io/tiktok-mcp/privacy.html) and
[Terms of Service](https://ivanbbaev.github.io/tiktok-mcp/terms.html), and those
are **not** the URLs to enter. They cover the distribution of this software and
the data behavior of the code you are about to run — where tokens are stored,
which hosts they are ever sent to, what leaves your machine. That is the factual
half of what your own policy has to state, since your app's data flows *are* this
server's data flows. Read them as source material and as a description of the
software; then write your policy under your own name.

## 2. Add the products

Products are added on the app page. Add only what you need; every product you
add is one more thing TikTok reviews at audit time.

| Product | Needed for | Tools it enables |
| ------- | ---------- | ---------------- |
| **Login Kit** | Always. Every token this server holds comes from Login Kit. | all |
| **Display API** | Reading the authorized account's profile and videos | `tiktok_get_user_info`, `tiktok_list_videos`, `tiktok_query_videos` |
| **Content Posting API** | Publishing videos and photo carousels, and reading publish status | `tiktok_get_creator_info`, `tiktok_get_publish_status`, `tiktok_post_video`, `tiktok_upload_video_draft`, `tiktok_post_photos`, `tiktok_upload_photos_draft` |

Scopes are requested per product. The tool packages of this server map onto them
as follows — `login` derives the scope list from the packages you enabled
(`TT_TOOL_PACKAGES`), so in practice you enable the product, and the CLI asks for
the matching scopes:

| Package | Scopes `login` requests |
| ------- | ----------------------- |
| `auth` | none (local state only) |
| `user` | `user.info.basic`, `user.info.profile`, `user.info.stats` |
| `video` | `video.list` |
| `publish` | `video.publish` |
| `publish-write` | `video.publish`, `video.upload` |

`video.publish` is direct posting; `video.upload` sends a draft to the creator's
TikTok inbox. `tiktok_get_publish_status` accepts either one.

If a scope is not enabled on the app, the TikTok authorization screen refuses it
and `login` fails on that scope — the app, not this server, is the gate.

## 3. Register the redirect URI

`login` runs the standard OAuth 2.0 authorization-code flow with PKCE and
catches the redirect on a loopback listener. Register exactly this shape as a
**redirect URI** on the app:

```
http://127.0.0.1:*/callback/
```

Three details that break the login if you get them wrong:

- **The trailing slash is mandatory.** A registration without it does not match
  the URI `login` sends, and TikTok rejects the authorization request on its own
  screen, before this server ever sees it.
- **`127.0.0.1`, not `localhost`, and never `::1`.** IPv6 loopback is not in
  TikTok's allowed host list; `login` binds IPv4 loopback only.
- **The port is a wildcard.** By default `login` binds an ephemeral port
  (`127.0.0.1:0`), so a busy port is a non-event.

If the portal will not accept a wildcard port for your app, pin one instead:
register `http://127.0.0.1:8000/callback/` and set `TT_REDIRECT_PORT=8000`. With
a pin, a port that cannot be bound is a hard failure naming `TT_REDIRECT_PORT` —
`login` never silently moves to a port shape you did not register.

Headless machine, or no browser on the box? `npx tiktok-mcp-ai login --manual`
prints the authorization URL, you open it anywhere, and paste the redirect URL
back. The manual flow still needs the same redirect URI registered.

## 4. Store the client key and secret

Both values belong in the env file, not in your MCP client's JSON config: the
env file is written owner-only and the client's config usually is not. On
macOS/Linux:

```bash
mkdir -p ~/.config/tiktok-mcp-ai
cat > ~/.config/tiktok-mcp-ai/.env <<'EOF'
TT_CLIENT_KEY=your-app-client-key
TT_CLIENT_SECRET=your-app-client-secret
EOF
chmod 600 ~/.config/tiktok-mcp-ai/.env
```

On Windows the same two lines go in `%LOCALAPPDATA%\tiktok-mcp-ai\.env`. There is
no mode to set there; the file inherits the ACLs of your user profile directory.

Real environment variables win over the file, so `TT_CLIENT_KEY=… npx
tiktok-mcp-ai doctor` works for a one-off check without touching the file.

Do not hand-write the token variables (`TT_ACCESS_TOKEN`, `TT_REFRESH_TOKEN`,
…). `login` and the refresh flow own them, and they are rewritten atomically
under a lock.

## 5. Authorize an account

```bash
npx tiktok-mcp-ai login
```

This opens the browser, captures the redirect, exchanges the code, and stores a
**refresh token** (never a password) in the env file. Useful options:

| Option | Effect |
| ------ | ------ |
| `--profile <name>` | Authorize a second account under that name |
| `--scopes <csv>` | Ask for an explicit scope list instead of the derived one |
| `--force` | Replace existing credentials without asking |
| `--manual` | Skip the loopback listener and paste the redirect by hand |
| `--no-browser` | Print the authorization URL instead of opening a browser |
| `--revoke` | Revoke the profile and clear its tokens |

Scopes are least-privilege by default: a read-only installation never holds a
token that could post. Adding publishing later is an explicit re-login with
`--scopes`.

## 6. Sandbox vs. production

A sandbox is attached to an app in the portal
([Add a sandbox](https://developers.tiktok.com/doc/add-a-sandbox/)). It exists so
you can call the APIs before the app is reviewed, with these consequences:

- A sandbox has its own **target users**, which you add explicitly. Only those
  accounts can authorize against it.
- **Sandbox never posts publicly.** Content Posting in a sandbox is
  `SELF_ONLY`; there is no way to make a sandbox post public.
- **URL properties do not carry over.** A domain verified in sandbox is not
  verified in production — see [§ 8](#8-verify-a-domain-for-url-posting).

Nothing in this server is sandbox-aware: the client key and secret you configure
decide which environment you are in. The one thing to remember is that a working
sandbox setup is not proof that production works, because of the two carry-over
rules above.

## 7. The audit gate

Until the app passes TikTok's content-sharing audit, TikTok — not this server —
enforces:

1. `creator_info` offers **only `SELF_ONLY`**, so every post is visible to its
   author alone, and the posting account **must itself be private**. Posting to
   a public account fails with
   `unaudited_client_can_only_post_to_private_accounts` (HTTP 403).
2. At most **5 distinct users** may post through the app per 24-hour window. The
   server surfaces this as the `active_user_cap` error.
3. After a successful audit the restrictions lift, but content already posted as
   `SELF_ONLY` stays private until the user changes it in the app.

This server honors the gate rather than working around it: it offers exactly the
privacy levels `creator_info` returned, and its errors explain the restriction.
The rules are TikTok's
([Content sharing guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines));
plan for them if you intend to publish publicly.

The submission asks again for the terms and privacy URLs of
[§ 1](#1-create-the-app), and here they are mandatory rather than optional: a
placeholder or a dead link is an easy rejection. They must be pages you publish
— see the note in § 1 for why this project's Privacy Policy and Terms of Service
are reference material and not something to submit as your own.

## 8. Verify a domain for URL posting

Only relevant if you post by URL (`PULL_FROM_URL`) rather than by uploading a
local file. TikTok downloads the media itself and refuses any URL that is not
under a verified property.

1. Portal → app page → **URL properties**.
2. Switch to **Production mode** first — a property verified in sandbox does not
   carry over.
3. Choose a property type:
   - **Domain** (covers every URL on that domain or subdomain): add the
     signature string as a DNS TXT record, then Verify. DNS propagation can take
     minutes to hours.
   - **URL prefix**: `https://` + host + path + trailing `/`. Download the
     signature file, serve it under that prefix, then Verify.
4. Prefix matching is path-segment-exact. Verified
   `https://example.com/videos/user/` covers
   `https://example.com/videos/user/123/clip.mp4` but not
   `https://example.com/videos/2023/user/123/clip.mp4`. Query strings do not
   affect matching, so signed query parameters are fine.

Runtime rules for the pulled URL: **HTTPS only**, **redirects are not
followed**, and the URL must stay reachable for the whole download window, which
times out one hour after the download task starts. Practical consequences: you
cannot post a third-party URL you do not control; a shared cloud hostname such
as `bucket.s3.amazonaws.com` normally cannot be verified (use a custom domain
you own); a CDN URL that redirects to origin fails. An unverified source fails
with `url_prefix_unverified`.

Optionally list your verified prefixes in `TT_VERIFIED_URL_PREFIXES`. It is
advisory only — it lets the plan phase flag an unverifiable URL before the call
goes out, and it never grants anything.

If you cannot verify a domain, upload local files instead: set `TT_MEDIA_ROOT`
to a dedicated directory and the posting tools read from there. No verification
is involved in that path.

## 9. Confirm it works

```bash
npx tiktok-mcp-ai doctor
```

`doctor` locates the env file, checks its permissions, confirms the client key
and secret are present, reports token expiry, compares granted scopes against
the enabled packages, and makes one live `user/info` call. Exit code `0` means
healthy (warnings allowed), `1` means a check failed.

If something is wrong, [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md) maps each
failure to a fix. To wire the server into an MCP client, see
[docs/CLIENTS.md](CLIENTS.md).

## Sources

- [Login Kit for Desktop](https://developers.tiktok.com/doc/login-kit-desktop) —
  loopback redirect and the hex PKCE deviation
- [Scopes overview](https://developers.tiktok.com/doc/scopes-overview)
- [Content Posting API — Get started](https://developers.tiktok.com/doc/content-posting-api-get-started)
- [Content sharing guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines)
- [Add a sandbox](https://developers.tiktok.com/doc/add-a-sandbox/)
- [App review guidelines](https://developers.tiktok.com/doc/app-review-guidelines)

[docs/TIKTOK-API.md](TIKTOK-API.md) is the annotated version of all of the
above, with the exact endpoints, limits and error codes this server relies on.
