# Security Policy

## Reporting a vulnerability

Please report security issues **privately** to
**Ivan Baev <ivanbbaev@gmail.com>**, or via a
[GitHub security advisory](https://github.com/IvanBBaev/tiktok-mcp/security/advisories/new).
Do not open a public issue for anything exploitable. I aim to acknowledge a
report within a few days and will credit you in the release notes unless you
prefer to stay anonymous.

For non-sensitive bugs, a normal
[GitHub issue](https://github.com/IvanBBaev/tiktok-mcp/issues) is fine.

## Security model (summary)

`tiktok-mcp-ai` is a local MCP server that talks to the official TikTok for
Developers APIs on your behalf. The full threat model lives in
[docs/SECURITY.md](docs/SECURITY.md); the essentials:

- **Transport.** `stdio` by default — no listening socket. The optional
  Streamable HTTP transport binds loopback, validates `Origin`/`Host` (even on
  loopback, against DNS rebinding), and **requires** a bearer token
  (`TT_HTTP_TOKEN`, constant-time comparison); a non-loopback bind additionally
  requires TLS in front or an explicit `TT_HTTP_INSECURE=1`.
- **Credentials.** OAuth 2.0 (PKCE) user tokens and the app client secret are
  stored in a local env file, never a password. **No secret is ever written to
  stdout, stderr, an MCP log, a tool result, an error message, a plan preview, or
  the publish journal** — redaction is a core primitive below every sink.
- **Write safety.** The four publishing tools are plan-then-execute: a call
  without a `plan_id` only previews and mints a single-use, digest-bound token;
  executing runs exactly the previewed payload. There is no way to post other
  than the payload a human could see, and a retry cannot double-post.
- **Network.** Egress is allowlisted — data calls reach only
  `open.tiktokapis.com`, uploads only the anchored TikTok upload hosts, and the
  OAuth authorize redirect only `www.tiktok.com`; all https/443, with
  `redirect: "error"` so a 3xx to any other host is never followed.
- **Local files.** `FILE_UPLOAD` reads only from `TT_MEDIA_ROOT` (fail-closed
  when unset), with `realpath` containment and TOCTOU re-validation between plan
  and execute.
- **Env file.** Written owner-only (`0600`) on POSIX with atomic,
  comment-preserving rewrites under a cross-process lock; on Windows the
  `%LOCALAPPDATA%` profile ACLs are the boundary.

## Hardened defaults

Out of the box the server is read-only and least-privilege:

- Default tool packages are `core` (the read tools only) — the four write tools
  are not registered unless you opt in, and a read-only deployment's login scopes
  never carry posting authority.
- Write mode defaults to `plan` (preview + `plan_id`); `apply` (no injection
  resistance) is opt-in for trusted automation only.
- Local-file posting is fail-closed until you set `TT_MEDIA_ROOT`.
- The AIGC (`is_aigc`) label defaults on; the upstream unaudited-app limits
  (SELF_ONLY, 5 users/24h) are honored, not circumvented.
- Results are size-budgeted and secrets are redacted everywhere; logs go to
  stderr only, keeping stdout pure JSON-RPC.

## Trademark

**Trademark & affiliation.** `tiktok-mcp-ai` is an independent, community-built
open-source project. It is **not** affiliated with, endorsed by, sponsored by,
or in any way officially connected to TikTok, ByteDance Ltd., or any of their
subsidiaries or affiliates.

"TikTok" and all related names, marks, logos, and brand features are trademarks
of ByteDance Ltd. and its affiliates. They are used in this project only
**nominatively** — to identify the third-party service that this MCP server
connects to — as permitted by nominative fair use. No sponsorship or endorsement
is implied.

This project accesses TikTok exclusively through the official TikTok for
Developers APIs and is subject to TikTok's Developer Terms of Service and
platform policies. You are responsible for your own use of the TikTok APIs and
for complying with all applicable TikTok terms. The software is provided "as is",
without warranty of any kind.
