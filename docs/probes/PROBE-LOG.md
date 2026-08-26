# Sandbox probe log

Empirical answers to the questions the TikTok documentation does not settle.
Each probe named here is executed by hand against a real sandbox app (task
**TD-7 / WP-2.6**, the Phase-2 exit gate) and its result recorded below.

**Nothing in this file is executed by CI.** CI never talks to TikTok — all
network is mocked (`docs/TESTING.md` § Harness). A probe is a human sitting in
front of a sandbox account with the MCP Inspector or `curl`, writing down what
actually came back.

**Status: no probe has been run yet.** Every row in the index is `not run`. The
probe definitions live in `docs/reviews/round2/SYNTHESIS.md` § 6; the spec
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

_None yet._

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
| P-15 | undici resolve-and-pin prototype behind the `lookup` seam¹          | none (v1.x)    | not run |
| P-16 | `creator_info` volatility across hours and days                     | none (tuning)  | not run |

¹ P-15 is an engineering spike, not a sandbox probe — it needs no TikTok
account and can be run offline. P-16 is optional tuning. Neither blocks Phase 2.
