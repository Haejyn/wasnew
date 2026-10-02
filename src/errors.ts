/**
 * Every refusal carries a stable `code` so callers (and agents) can branch on it
 * and translate the message — the English text is for logs, not for matching.
 */
export type WasnewErrorCode =
  | "DEST_EXISTS"
  | "OUTSIDE_ROOT"
  | "IN_STORE"
  | "CROSS_DEVICE_DIR"
  | "COPY_MISMATCH"
  | "SNAPSHOT_NOT_FOUND"
  | "NOT_IN_SNAPSHOT"
  | "BAD_SNAPSHOT_ID"
  | "RESERVED_OP"
  | "LOCKED"
  | "GC_NEEDS_POLICY"
  | "POLICY_INVALID"
  | "POLICY_PROTECTED"
  | "POLICY_LIMIT"
  | "POLICY_DENIED"
  | "NEEDS_APPROVAL"
  | "PLAN_NOT_FOUND"
  | "PLAN_INVALID"
  | "PLAN_APPLIED"
  | "NOT_FOUND";

export class WasnewError extends Error {
  constructor(readonly code: WasnewErrorCode, message: string, readonly path?: string) {
    super(message);
    this.name = "WasnewError";
  }
}

export function isWasnewError(e: unknown, code?: WasnewErrorCode): e is WasnewError {
  return e instanceof WasnewError && (code === undefined || e.code === code);
}
