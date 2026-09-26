# Sandbox probe log

Empirical answers to the questions the TikTok documentation does not settle.
Each probe named here is executed by hand against a real sandbox app (task
**TD-7 / WP-2.6**, the Phase-2 exit gate) and its result recorded below.

**Nothing in this file is executed by CI.** CI never talks to TikTok — all
network is mocked (`docs/TESTING.md` § Harness). A probe is a human sitting in
front of a sandbox account with the MCP Inspector or `curl`, writing down what
actually came back.

**Status: one probe has been run** — P-15, the offline engineering spike, on
2026-08-31. Every probe that needs a live sandbox account is still `not run`.
The probe definitions live in `docs/reviews/round2/SYNTHESIS.md` § 6; the spec
references live in `docs/TIKTOK-API.md` Appendix A; the convention this file
follows is normative in `docs/TESTING.md` § Sandbox probes and the probe log.

## Rules

- **Sandbox is `SELF_ONLY`.** The sandbox cannot post publicly, so every probe
  that publishes runs with `privacy_level: SELF_ONLY` against a target-user
  account. The audit demo video is shot later, on unaudited production with a
  private account — that is not a probe and does not belong in this file.
- **Redact exactly as a recorded fixture is redacted.** No raw access or refresh
  token, no `upload_url`, no `upload_token`, no `open_id`, no `log_id` that
  identifies a real account. Replace each with a stable placeholder
  (`<ACCESS_TOKEN>`, `<UPLOAD_URL>`, …) so two entries can still be compared.
- **A result that contradicts the spec is never folded in silently.** It goes
  through the contract-change process (`docs/CONTRACTS.md` § Change log): the
  probe entry records the finding, the spec edit lands as its own change with
  the probe number as its rationale.
- **Record failures and inconclusive runs too.** "The endpoint 500'd four times
  in a row and we gave up" is a result; deleting it loses the only evidence that
  the question is still open.

## Entry template

Copy this block for every executed probe and append it under `## Entries`,
newest last.

```markdown
### P-N — <one-line restatement of the question>

- **Date:** YYYY-MM-DD
- **App / account:** sandbox app `<name>`, target-user account `<placeholder>`
- **Request:** method, endpoint, the fields that mattered (redacted)
- **Response:** status, the fields that mattered, `log_id` only if it is safe
  to keep (redacted otherwise)
- **Conclusion:** the empirical answer, in one or two plain sentences.
- **Spec impact:** which document/contract changes, with the section number —
  or explicitly `none`.
```

## Entries

### P-15 — can the pre-flight/connect DNS gap be closed on stock Node, and at what cost?

- **Date:** 2026-08-31
- **App / account:** none. P-15 is an engineering spike, not a sandbox probe: no
  TikTok app, no account, no token, nothing to redact. It contacted only
  loopback servers it started itself.
- **Request:** `node --experimental-strip-types scripts/spikes/p15-resolve-and-pin.ts`
  on Node v22.23.2 / darwin; the whole run takes seconds. The spike replaces
  `dns.lookup` with a scriptable resolver and binds two servers on one port —
  `127.0.0.1` answering `VETTED`, `::1` answering `REBOUND` — so the response
  body reads out which address the socket actually reached. `openssl` was
  present, so the TLS section ran rather than skipping.
- **Response:** 25 claims checked — **25 PASS, 0 FAIL, 0 SKIP**. What each
  section settled:
  - **The v1 gap is real, not theoretical (§ 2).** Against a rebinding
    resolver the pre-flight vetted `127.0.0.1` and `fetch` then reached
    `REBOUND`, after two resolutions of the same name.
  - **A `lookup`-shaped pin closes it (§ 3), by two routes.** `node:http`
    honours `request({ lookup })` natively (`body=VETTED`,
    `remoteAddress=127.0.0.1`); `fetch` only through an undici `Agent` with
    `connect.lookup`. Under both the pinned request consults the resolver 0
    times. Control: the same `node:http` call without `lookup` returns
    `REBOUND`.
  - **Pinning does not weaken TLS identity (§ 4).** Under a pin the certificate
    is still validated against the hostname (`authorized=true`,
    `peerCN=pinned.p15.invalid`), and a trusted certificate for the wrong name
    is still rejected with `ERR_TLS_CERT_ALTNAME_INVALID` — through
    `node:https` and through the pinned `Agent` alike. The usual objection,
    that pinning trades DNS safety for certificate safety, does not hold.
  - **Cost is not what blocks it (§ 5),** over 200 sequential loopback requests
    each: (a) plain `fetch`, the v1 default, mean 1.801 ms; (b) pre-flight +
    `fetch`, 1.624 ms; (c) pre-flight + a pinned `Agent`, 1.639 ms — resolver
    calls for 201 requests 2 / 201 / 201. The pre-flight already pays the
    per-request resolution, and adding the pin on top of it costs nothing
    measurable; a repeat run moved a, b and c further than they differ from
    each other. (Row (d), `node:http` at 0.189 ms, is a different client, not a
    saving from pinning.)
  - **What blocks it is reachability and stability of the `fetch` route
    (§ 1).** `undici` is importable neither as a package nor as `node:undici`;
    no undici class is a global; a real `Agent` class is reachable **only**
    through `globalThis[Symbol.for('undici.globalDispatcher.1')]`, which is
    undocumented and version-keyed. That dispatcher does not exist in a fresh
    process until something creates it (an ESM import of `node:http`, or a
    first `fetch`, is enough), and the class behind the symbol depends on the
    environment: with `NODE_USE_ENV_PROXY=1` and `HTTP_PROXY` set it is an
    `EnvHttpProxyAgent`, where the pin would apply to the proxy address rather
    than to the API host.
  - **Keep-alive caveat (§ 3b).** A pinned socket carries its pin into later,
    unpinned requests on the same pooled connection — "pinned" is a property of
    a connection's lifetime, not of a request. Here it errs towards the vetted
    address, but any future implementation has to reason about it and say which
    one it means.
  - `node:http` never follows a redirect by itself (302 returned, not
    followed), which matches the CC-B6 posture already relied on.
- **Conclusion:** Resolve-and-pin stays deferred out of v1, now for a measured
  reason instead of an assumed one: the gap is reproducible, a `lookup`-shaped
  pin closes it on stock Node without weakening TLS and at no measurable cost,
  but the only route that reaches `fetch` is an undocumented, lazily created,
  environment-dependent global symbol. Proven here: that the gap is reachable
  and that a pin closes it. Not proven, and not claimed: that either route is
  stable enough to ship — so v1 keeps the pre-flight and the compensating
  controls, and the `lookup` seam stays the place a later flip lands.
- **Spec impact:** `docs/SECURITY.md` § "DNS resolve-and-pin: deferred out of
  v1 (accepted risk)" — the "Obligations that survive the deferral" paragraph
  is rewritten to record the spike as run and the deferral as evidence-backed;
  the decision itself is unchanged. `none` for every other document, and
  nothing under `src/` changes as a result.

## Index

`Blocks` is the freeze point the probe gates, from SYNTHESIS § 6. A probe with
no freeze point still gets recorded; it simply does not hold anything up.

| #    | Question it answers                                                | Blocks         | Status  |
| ---- | ------------------------------------------------------------------ | -------------- | ------- |
| P-1  | `status/fetch` retention window for a `publish_id` (CC-E8)          | WP-2.3         | not run |
| P-2  | Re-PUT tolerance of an already-accepted chunk range (CC-D6)         | WP-2.4         | not run |
| P-3  | Refresh-token rotation grace window on two rapid refreshes          | WP-1.1         | not run |
| P-4  | Out-of-scope field on a read: silent omit or error                  | WP-1.5         | not run |
| P-5  | Revoke mid-upload — the 401-after-init behaviour                    | WP-2.4         | not run |
| P-6  | `brand_content_toggle` + `SELF_ONLY` at the API, not just the docs  | WP-2.1         | not run |
| P-7  | Inbox-draft expiry, for the `user_action` hint                      | WP-2.5         | not run |
| P-8  | Display-read limit dimension: per-token or per-app                  | WP-0.5 tuning  | not run |
| P-9  | `upload_url` hosts across runs, incl. an EEA account if available   | WP-0.5         | not run |
| P-10 | Whether drafts consume the 5-users/24 h unaudited cap               | WP-2.5 texts   | not run |
| P-11 | Raw chunk-PUT responses: 206/201, the 416 body + headers, 5xx shape | WP-2.4         | not run |
| P-12 | Two byte-identical inits back-to-back — upstream dedup or not       | WP-2.2 texts   | not run |
| P-13 | Photo-draft `title`/`description`; photo direct-post `auto_add_music` | WP-2.5 schemas | not run |
| P-14 | `upload_url` anatomy: host, `upload_token` param, observed TTL      | WP-2.4         | not run |
| P-15 | undici resolve-and-pin prototype behind the `lookup` seam¹          | none (v1.x)    | run 2026-08-31 |
| P-16 | `creator_info` volatility across hours and days                     | none (tuning)  | not run |

¹ P-15 is an engineering spike, not a sandbox probe — it needs no TikTok
account and can be run offline. P-16 is optional tuning. Neither blocks Phase 2.
