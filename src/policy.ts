import { promises as fs } from "node:fs";
import { WasnewError } from "./errors.js";
import { ignoredBy, parseIgnore } from "./ignore.js";

/**
 * `.wasnew/policy.json` — limits a person sets for what programs may do in this folder.
 * A malformed policy fails closed: every guarded operation refuses until it is fixed.
 */
export interface Policy {
  /** gitignore-style patterns nothing may move, trash or move onto */
  protect?: string[];
  /** most moves + trashes one batch may hold */
  maxOpsPerBatch?: number;
  /** plans (and MCP calls) bigger than this need a person's `approve` first */
  requireApprovalOver?: number;
  /** false turns trash off entirely */
  allowTrash?: boolean;
}

export interface LoadedPolicy {
  policy: Policy;
  isProtected(rel: string): boolean;
}

const EMPTY: LoadedPolicy = { policy: {}, isProtected: () => false };

function count(v: unknown, key: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new WasnewError("POLICY_INVALID", `policy.${key} must be a non-negative integer`);
  return v;
}

export function parsePolicy(raw: unknown): LoadedPolicy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new WasnewError("POLICY_INVALID", "policy must be a JSON object");
  const o = raw as Record<string, unknown>;
  const known = new Set(["protect", "maxOpsPerBatch", "requireApprovalOver", "allowTrash"]);
  const unknown = Object.keys(o).filter((k) => !known.has(k));
  if (unknown.length) throw new WasnewError("POLICY_INVALID", "unknown policy keys: " + unknown.join(", "));
  if (o.protect !== undefined && (!Array.isArray(o.protect) || o.protect.some((p) => typeof p !== "string"))) {
    throw new WasnewError("POLICY_INVALID", "policy.protect must be a list of patterns");
  }
  if (o.allowTrash !== undefined && typeof o.allowTrash !== "boolean") throw new WasnewError("POLICY_INVALID", "policy.allowTrash must be true or false");
  const policy: Policy = {
    protect: o.protect as string[] | undefined,
    maxOpsPerBatch: count(o.maxOpsPerBatch, "maxOpsPerBatch"),
    requireApprovalOver: count(o.requireApprovalOver, "requireApprovalOver"),
    allowTrash: o.allowTrash as boolean | undefined,
  };
  let rules;
  try {
    rules = parseIgnore((policy.protect ?? []).join("\n"));
  } catch (e: any) {
    throw new WasnewError("POLICY_INVALID", "bad protect pattern: " + (e?.message ?? e));
  }
  return { policy, isProtected: (rel) => rules.length > 0 && ignoredBy(rules, rel) };
}

/** Re-reads only when the file changed, so a check per move costs one stat */
export class PolicyFile {
  private cached: LoadedPolicy = EMPTY;
  private stamp = "";

  constructor(private readonly file: string) {}

  async get(): Promise<LoadedPolicy> {
    let st;
    try {
      st = await fs.stat(this.file);
    } catch {
      this.cached = EMPTY;
      this.stamp = "";
      return EMPTY;
    }
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (stamp === this.stamp) return this.cached;
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (e: any) {
      throw new WasnewError("POLICY_INVALID", "policy.json is not valid JSON: " + (e?.message ?? e));
    }
    this.cached = parsePolicy(raw);
    this.stamp = stamp;
    return this.cached;
  }
}
