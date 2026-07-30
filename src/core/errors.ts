/**
 * Error taxonomy — the single error type the whole server throws.
 *
 * Spec: ARCHITECTURE.md § 11 (error taxonomy), TOOLS.md § 3.0 (the stable code
 * catalog with normative message texts), CORNER-CASES.md CC-B9 (upstream
 * `log_id` may be absent — nothing may assume its presence).
 *
 * Design notes:
 *
 * - One class, discriminated by `kind`, so every layer can map an error to a
 *   tool-result envelope without a `switch` over constructor identities.
 * - Messages are written for the model: state the cause, then the recovery
 *   action. The normative texts live in the TOOLS.md catalog and are asserted
 *   by substring in the tool-level tests; this module only carries them.
 * - `message` and `remediation` are free text and therefore pass through
 *   `core/redact`'s `redactText` at construction time — redaction is a core
 *   primitive *below* every sink (ARCHITECTURE.md § 10, SECURITY.md
 *   § Redaction), so an error that is later logged, journaled, or returned to
 *   the model can never leak a registered secret that was interpolated into
 *   its message.
 */

import { redactText } from './redact.js';

export type ErrorKind =
  | 'config' // startup/env problems
  | 'auth' // token/scope problems (incl. terminal re-login)
  | 'api' // upstream { error.code !== "ok" }
  | 'network' // transport failures
  | 'validation' // local input rejection (no network spent)
  | 'policy' // local write-safety rejection (plan, duplicate, rate)
  | 'internal';

export class TikTokError extends Error {
  readonly kind: ErrorKind;

  /**
   * Stable machine code, e.g. "local_rate_limited", "plan_not_found",
   * "env_file_busy", "network_unsent". Catalog + normative user texts:
   * TOOLS.md § 3.0 error catalog (substring-tested).
   */
  readonly code: string;

  /** Upstream `error.code`, when `kind === "api"`. */
  readonly apiCode?: string;

  /**
   * Upstream `log_id`, when the response carried one. Optional by contract:
   * TikTok omits it on some error shapes, and no formatting path may depend
   * on it (CC-B9).
   */
  readonly logId?: string;

  /**
   * Whether an identical retry is *permitted*. Conservative default `false`:
   * a write must never be replayed just because the caller forgot to decide.
   * Mirrors the "Retryable" column of the TOOLS.md § 3.0 catalog.
   */
  readonly retryable: boolean;

  /** Operator-facing next step (a CLI line, a config change, …), when known. */
  readonly remediation?: string;

  constructor(opts: {
    kind: ErrorKind;
    code: string;
    message: string;
    apiCode?: string;
    logId?: string;
    retryable?: boolean;
    remediation?: string;
    cause?: unknown;
  }) {
    super(
      redactText(opts.message),
      opts.cause === undefined ? undefined : { cause: opts.cause },
    );
    this.name = 'TikTokError';
    this.kind = opts.kind;
    this.code = opts.code;
    this.apiCode = opts.apiCode;
    this.logId = opts.logId;
    this.retryable = opts.retryable ?? false;
    this.remediation =
      opts.remediation === undefined ? undefined : redactText(opts.remediation);
  }
}

/**
 * Type guard used at every catch site. `instanceof` is the identity check: the
 * server ships as a single package with one copy of this module, so there is no
 * realm/duplicate-instance hazard to work around.
 */
export function isTikTokError(e: unknown): e is TikTokError {
  return e instanceof TikTokError;
}
