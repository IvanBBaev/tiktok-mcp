# Security Policy

This file is the **disclosure policy**: which versions get fixes, how to report a
vulnerability privately, and what is in scope. It is deliberately short. The
design-security document — threat model, secret handling and redaction, egress
allowlist, transport hardening, write safety, supply chain — is
[docs/SECURITY.md](docs/SECURITY.md).

## Supported versions

`tiktok-mcp-ai` is **pre-1.0 and not yet released**: there is no published
version, so today there is nothing to backport to. Once a release exists:

| Version             | Supported                          |
| ------------------- | ---------------------------------- |
| Latest release      | Yes                                |
| Any earlier release | No — upgrade to the latest release |
| `main` (unreleased) | Yes, as the branch a fix lands on  |

This is a solo-maintained project. There is no LTS branch and no backporting: a
security fix ships in the next release cut from `main`, in a patch if it can be
one. While the version is `0.x` that release may also carry breaking changes —
see [docs/SECURITY.md § Compatibility and deprecation policy](docs/SECURITY.md#compatibility-and-deprecation-policy),
whose security exception says exactly this.

## Reporting a vulnerability

**Do not open a public issue for anything exploitable.** Use one of these:

1. **Preferred — GitHub private vulnerability reporting.** Repository
   **Security** tab →
   [**Report a vulnerability**](https://github.com/IvanBBaev/tiktok-mcp/security/advisories/new).
   The report stays private to you and the maintainer, the whole exchange lives
   next to the code, and it is the channel that can turn into a published GitHub
   Security Advisory with a CVE if the finding warrants one.
2. **Fallback — email.** Ivan Baev, **ivanbbaev@gmail.com**. Use this if the
   Security tab is unavailable to you for any reason.

There is **no PGP key, no `security@` address and no bug bounty** — please do not
wait for any of them, and treat any claim that they exist as false.

A useful report says what the vulnerability is, which version or commit you
tested, the configuration it needs (transport, `TT_WRITE_MODE`, which tool
packages, whether `TT_MEDIA_ROOT` is set), and the smallest reproduction you
have. **Never paste a real `TT_CLIENT_SECRET`, OAuth token or env file** into a
report — redact them; they are not needed to demonstrate a finding.

For non-sensitive bugs, a normal
[GitHub issue](https://github.com/IvanBBaev/tiktok-mcp/issues) is the right
place.

## What to expect

- **Acknowledgement within a few days.** Not hours — one person maintains this,
  in their own time.
- An assessment of whether it is in scope and what severity I think it carries,
  with reasoning you are welcome to argue with.
- A fix in the next release once one is agreed, and a `Security` entry in
  [CHANGELOG.md](CHANGELOG.md) describing it.
- **Credit in the release notes and the advisory**, unless you prefer to stay
  anonymous — say so and you will not be named.

These are intentions, not an SLA: nothing here promises a response time a solo
maintainer cannot keep. In return, please allow a reasonable coordinated
window — **90 days is the customary default** — before disclosing publicly, and
tell me if you have a deadline of your own so we can plan around it rather than
be surprised by it.

## Scope

**In scope** — anything in this repository that weakens the guarantees
[docs/SECURITY.md](docs/SECURITY.md) claims, for example:

- a secret (`TT_CLIENT_SECRET`, an access or refresh token, `TT_HTTP_TOKEN`, an
  `upload_token`) reaching stdout, stderr, a log, a tool result, an error
  message, a plan preview or the publish journal;
- a way to reach a host outside the documented egress allowlist, or to have the
  account bearer token sent to an upload host;
- a way to read or upload a file outside `TT_MEDIA_ROOT`, or to change the bytes
  between the plan preview and the execute;
- a way to publish content that differs from the previewed payload, to bypass
  the `plan_id` gate, or to double-post on a retry;
- an authentication or `Origin`/`Host` bypass on the HTTP transport;
- env file or journal permissions weaker than documented on POSIX;
- a supply-chain weakness in how this repository builds, tests or publishes
  itself.

**Out of scope:**

- **Vulnerabilities in TikTok's own API, platform or web properties.** This
  project is an independent client of the official TikTok for Developers APIs
  and cannot fix them — report those to TikTok, not here.
- **Anything that presupposes the attacker already has the credential**, i.e.
  that requires the attacker to already hold your `TT_CLIENT_SECRET`, your OAuth
  tokens, or read access to your env file. Those _are_ the keys; possessing them
  is the compromise, not a path to one.
- Attacks by a **local root/administrator user**, or by a **compromised MCP
  client** — both are declared non-goals in
  [docs/SECURITY.md § Threat model](docs/SECURITY.md#threat-model), because the
  client sees every tool result by design.
- The **accepted risks recorded in docs/SECURITY.md**, unless you can defeat the
  compensating controls: notably DNS resolve-and-pin being deferred out of v1
  (an attacker who controls DNS for an allowlisted name still has to defeat TLS).
- Reports from automated scanners with no demonstrated impact, missing security
  headers on the GitHub Pages documentation site, and findings in dependencies
  that are already covered by an upstream advisory — Dependabot is watching for
  those.

## What is already automated

Reported findings are triaged on top of gates that already run in CI:

- **CodeQL** (`javascript-typescript`, `security-and-quality` queries) on every
  push to `main`, every pull request, and weekly —
  [`.github/workflows/codeql.yml`](.github/workflows/codeql.yml).
- **Dependabot** on npm (root and `extension/`) and on GitHub Actions, weekly —
  [`.github/dependabot.yml`](.github/dependabot.yml).
- **`npm audit --omit=dev --audit-level=high`** in CI, which fails the build on a
  high or critical advisory in a runtime dependency.
- **GitHub Actions pinned by commit SHA**, and **npm publishing via trusted
  publishing (OIDC) with provenance** — there is no long-lived npm token in this
  repository. See [docs/SECURITY.md § Supply chain / code](docs/SECURITY.md#supply-chain--code).

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
