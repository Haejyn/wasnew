/**
 * wasnew — keeps the moment things were new.
 *
 * A local safety net that borrows only git's core ideas:
 *   content-addressed (sha256) blobs · snapshot manifests · restore · a move journal.
 * No branches, merges or remotes. **It never deletes user files** — restore overwrites
 * (and snapshots what it overwrites first), files absent from a snapshot are left alone,
 * and moves are undone from the journal.
 *
 * Layout (<root>/.wasnew/):
 *   objects/<aa>/<rest of hash>   content-addressed blobs (same content stored once)
 *   snapshots/<id>.json           manifest { id, label, created, files[] }
 *   journal.jsonl                 append-only log; undo is recorded, never erased
 *   trash/<id>/<path>             what trash() set aside — undo puts it back
 *   plans/<id>.json               proposed operations waiting for apply (and maybe a person's approval)
 *   inflight/<id>.json            the operation being performed right now — recover() reads leftovers
 *   policy.json                   limits a person sets (see policy.ts)
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fs, createReadStream, createWriteStream, watch as watchFs } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { WasnewError } from "./errors.js";
import { ignoredBy, parseIgnore } from "./ignore.js";
import { withLock } from "./lock.js";
import { PolicyFile, type LoadedPolicy } from "./policy.js";

export { WasnewError, isWasnewError, type WasnewErrorCode } from "./errors.js";
export { wasnewIgnored, parseIgnore, ignoredBy } from "./ignore.js";
export { parsePolicy, type Policy, type LoadedPolicy, type TrustPolicy } from "./policy.js";
export { summarizeOps, type SummaryOp, type OpSummary } from "./summary.js";

const STORE_DIR = ".wasnew";
const IGNORE_FILE = ".wasnewignore";
const TMP_PREFIX = ".wasnew-tmp-";
const DEFAULT_IGNORE = [STORE_DIR, ".git", "node_modules", ".DS_Store", "Thumbs.db", "desktop.ini"];
/** gc leaves young blobs alone — a snapshot running concurrently may have written them before its manifest */
const GC_GRACE_MS = 10 * 60_000;
const RACY_MS = 2000;
/**
 * Moves, trashes and undos are committed in groups of this many: one inflight marker, one lock
 * and one journal write per group instead of per operation (3,004 single moves took 7.5 s on NTFS).
 */
const GROUP_SIZE = 256;
/** Files up to this size are read once into memory and hashed from the buffer; larger ones stream */
const SMALL_FILE_MAX = 4 * 1024 ** 2;
/** Files a snapshot works on at the same time (stat, hash, store) */
const CAPTURE_CONCURRENCY = 16;
/** A pattern counts as fine to keep doing only after it stood this long without an undo */
const CONFIRMED_AFTER_MS = 86_400_000;
const REASON_MAX = 60;
/** Same order as String#localeCompare with no arguments, without building a collator per call */
const byLocale = new Intl.Collator().compare;

export interface SnapshotFile {
  /** root-relative, posix separators */
  path: string;
  hash: string;
  size: number;
}
export interface SnapshotMeta {
  id: string;
  label?: string;
  created: string;
  fileCount: number;
  journalSeq?: number;
  /** only some files were captured (e.g. the guard taken before a restore) */
  partial?: boolean;
}
export interface Snapshot extends SnapshotMeta {
  files: SnapshotFile[];
}

/** Who did it and why — kept on every entry an agent causes, so "who moved my file?" has an answer */
export interface Actor { agent?: string; model?: string; reason?: string; session?: string }

/** `batch` groups one task so undo can roll it back as a unit instead of counting moves */
interface JournalMove { seq: number; op: "move"; from: string; to: string; at: string; batch?: string; by?: Actor; redoOf?: number; dir?: true }
/**
 * `to` is relative to the store: trash/<id>/<path>. `redoOf`: the undone op this one re-applies.
 * `dir`: what moved was a folder (always set for trash, for a move only when the name has no extension).
 */
interface JournalTrash { seq: number; op: "trash"; from: string; to: string; at: string; batch?: string; by?: Actor; redoOf?: number; dir?: true }
interface JournalUndo { seq: number; op: "undo"; of: number; at: string; by?: Actor }
interface JournalRestore { seq: number; op: "restore"; snapshot: string; paths: string[]; at: string; guard?: string; by?: Actor }
interface JournalNote { seq: number; op: string; at: string; [key: string]: unknown }
export type JournalEntry = JournalMove | JournalTrash | JournalUndo | JournalRestore | JournalNote;
type Movement = JournalMove | JournalTrash;
const RESERVED_OPS = new Set(["move", "trash", "undo", "restore", "purge", "plan", "approve", "apply"]);

export interface MoveRecord { from: string; to: string; at: string; batch?: string; trashed?: true; by?: Actor }
export interface UndoSkip extends MoveRecord { reason: string; message: string }
export interface UndoResult { undone: MoveRecord[]; skipped: UndoSkip[] }
/** `redone`: the new ops, so `to` of a trash is its new place in the trash */
export interface RedoResult { redone: MoveRecord[]; skipped: UndoSkip[] }
/**
 * One kind of operation as the journal saw it: op, file type, source folder, destination folder.
 * `avoid`: undone at least minUndone times and in at least half the cases. `ok`: done at least 5
 * times over more than a day and never undone. A redo that stayed brings its op back to kept.
 */
export interface Lesson {
  kind: "avoid" | "ok";
  op: "move" | "trash";
  /** lower-case extension without the dot, "folder", or "" for a file without one */
  ext: string;
  fromDir: string;
  /** destination folder, or "trash" */
  toDir: string;
  total: number;
  undone: number;
  kept: number;
  agents: string[];
  /** reasons given for the latest undone ops, newest first, at most 2 */
  reasons: string[];
  first: string;
  last: string;
  line: string;
}
export interface Lessons { avoid: Lesson[]; ok: Lesson[] }
/** An avoid lesson that matches `matches` operations of a list being proposed */
export interface PlanLesson extends Lesson { matches: number }
export interface AgentRecord { agent: string; ops: number; undone: number; undoRate: number; firstSeen: string; lastSeen: string }
export interface RestoreResult { restored: number; skipped: number; guard?: string }
export interface Diff { added: string[]; changed: string[]; missing: string[]; moved: { from: string; to: string }[] }
export interface SnapshotResult extends SnapshotMeta {
  newBlobs: number;
  /** files actually read this time — the rest matched the stat cache */
  hashed?: number;
  /** nothing changed since the last snapshot, which is returned instead of a new one */
  unchanged?: boolean;
}
interface StatCache { snapshot?: string; files: Record<string, [size: number, mtimeMs: number, hash: string]> }
export interface GcResult { dryRun: boolean; snapshots: string[]; blobs: number; bytes: number }

export type PlanOp = { op: "move"; from: string; to: string } | { op: "trash"; path: string };
export interface PlanIssue { index: number; code: string; message: string }
export interface Plan {
  id: string;
  created: string;
  ops: PlanOp[];
  /** problems found when the plan was made — a plan with issues cannot be applied */
  issues: PlanIssue[];
  /** the folder's policy wants a person to approve this plan before it runs */
  needsApproval: boolean;
  by?: Actor;
  approved?: { at: string; by?: string };
  applied?: { at: string; batch: string };
}
export interface OpFailure { index: number; code: string; message: string }
export interface ApplyResult { plan: string; batch: string; done: number; failed?: OpFailure }
/** What moveMany and trashMany did: `done` ops in order, then stopped at `failed` if anything went wrong */
export interface ManyResult {
  done: number;
  /** trashMany: where each done op went, relative to the store */
  trashed?: string[];
  failed?: OpFailure;
}
export interface HistoryEvent { seq: number; op: string; at: string; from?: string; to?: string; batch?: string; by?: Actor; undone?: boolean }
/** One journal entry that carried a path along: `to` is store-relative after a trash, absent for a purge */
export interface WhereStep { seq: number; op: "move" | "trash" | "undo" | "purge"; from: string; to?: string; at: string; by?: Actor; batch?: string }
/**
 * Where a path's file is now. `here`: something exists at the path. `moved`: it exists at `current`.
 * `trashed`: it sits in the trash at `current` (store-relative); undoing `batch` brings it back.
 * `purged`: it was trashed and the trash was emptied. `unknown`: the journal knows nothing, or
 * (`missing`) it points at `current` but nothing is there now.
 */
export interface WhereResult {
  path: string;
  status: "here" | "moved" | "trashed" | "purged" | "unknown";
  current?: string;
  missing?: true;
  /** the move or trash that put it where it is (an undone one does not count): when, by whom, which batch to undo */
  at?: string;
  by?: Actor;
  batch?: string;
  steps: WhereStep[];
}
export interface RecoverItem { op: string; from: string; to: string; outcome: "journaled" | "not-started" | "both-exist" | "missing" | "in-progress" }
export interface TrashPurge { dryRun: boolean; entries: { from: string; to: string; at: string }[]; bytes: number }
export interface VaultOptions {
  /** extra file or folder names never captured (on top of .git, node_modules, OS litter) */
  ignore?: string[];
}

type JournalLine = { op: string; at: string; [key: string]: unknown };
/** One operation of a group, as written to the inflight marker */
interface InflightItem { src: string; dst: string; entry: Record<string, unknown> & { op: string }; looksDone?: boolean }
interface PerformItem extends InflightItem { kind: "move" | "trash"; caseOnly: boolean; rel: string; storeTo?: string }
interface UndoItem extends InflightItem { m: Movement; caseOnly: boolean }
interface RedoItem extends InflightItem { m: Movement; caseOnly: boolean; storeTo?: string }
interface PatternShape { key: string; op: "move" | "trash"; ext: string; fromDir: string; toDir: string }
interface Pattern extends PatternShape { total: number; undone: number; agents: Set<string>; reasons: string[]; first: string; last: string }
interface GroupOutcome { done: number[]; errors: { i: number; error: unknown }[]; journalError?: unknown }
/** Per capture: folders already made (so a blob costs no mkdir) and hashes some file of it is storing */
interface StoreCtx { made: Set<string>; claimed: Set<string> }

/**
 * Runs `fn` over `items` with at most `limit` in flight. After the first failure no new item
 * starts; it waits for the running ones and then throws, so nothing keeps writing after it returns.
 */
async function eachLimit<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failed: { error: unknown } | undefined;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try { await fn(items[i], i); } catch (error) { failed ??= { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failed.error;
}

function failure(index: number, e: any): OpFailure {
  return { index, code: e?.code ?? "ERROR", message: String(e?.message ?? e) };
}

function toPosix(rel: string): string {
  return rel.replaceAll("\\", "/");
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

/** Streams instead of reading whole files — the big ones are usually multi-GB videos */
async function hashFile(abs: string): Promise<{ hash: string; size: number }> {
  const h = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(abs)) {
    h.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { hash: h.digest("hex"), size };
}

async function hashIfFile(abs: string): Promise<string | null> {
  try {
    if (!(await fs.stat(abs)).isFile()) return null;
    return (await hashFile(abs)).hash;
  } catch {
    return null;
  }
}

function snapshotId(created: string): string {
  // readable ms timestamp + randomness — never collides, even for the same instant and content
  return created.replaceAll(/[-:.]/g, "").replace("T", "-").replace("Z", "") + "-" + randomBytes(2).toString("hex");
}

/**
 * Trash folder ids for one group: trash/<id>/<path>, one id for the whole group so 500 trashes make
 * one folder. Two paths of a group that are the same (trash a, move b to a, trash a) or where one
 * holds the other (trash a/b, then a) would collide in one folder, so such a path gets a fresh id.
 * Compared without case, since Windows and macOS see A and a as one name.
 */
class TrashIds {
  private readonly slots: { id: string; used: Set<string>; held: Set<string> }[] = [];
  for(from: string): string {
    const key = from.toLowerCase();
    const parts = key.split("/");
    const ancestors = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
    let slot = this.slots.find((s) => !s.held.has(key) && !ancestors.some((a) => s.used.has(a)));
    if (!slot) {
      let id: string;
      do id = snapshotId(new Date().toISOString()); while (this.slots.some((s) => s.id === id));
      slot = { id, used: new Set(), held: new Set() };
      this.slots.push(slot);
    }
    slot.used.add(key);
    slot.held.add(key);
    for (const a of ancestors) slot.held.add(a);
    return slot.id;
  }
}

export class Vault {
  private readonly ignoreNames: Set<string>;
  private readonly policyFile: PolicyFile;

  private constructor(readonly root: string, opts: VaultOptions) {
    this.ignoreNames = new Set([...DEFAULT_IGNORE, ...(opts.ignore ?? [])]);
    this.policyFile = new PolicyFile(path.join(root, STORE_DIR, "policy.json"));
  }

  private get store() { return path.join(this.root, STORE_DIR); }
  private get journalPath() { return path.join(this.store, "journal.jsonl"); }
  private get lockPath() { return path.join(this.store, "journal.lock"); }
  private get tmpDir() { return path.join(this.store, "tmp"); }
  private get trashDir() { return path.join(this.store, "trash"); }
  private get plansDir() { return path.join(this.store, "plans"); }
  private get inflightDir() { return path.join(this.store, "inflight"); }
  private objPath(hash: string) { return path.join(this.store, "objects", hash.slice(0, 2), hash.slice(2)); }
  private manifestPath(id: string) {
    if (!/^[\w-]+$/.test(id)) throw new WasnewError("BAD_SNAPSHOT_ID", "invalid snapshot id: " + id);
    return path.join(this.store, "snapshots", id + ".json");
  }

  static async open(root: string, opts: VaultOptions = {}): Promise<Vault> {
    const v = new Vault(path.resolve(root), opts);
    await fs.mkdir(path.join(v.store, "objects"), { recursive: true });
    await fs.mkdir(path.join(v.store, "snapshots"), { recursive: true });
    return v;
  }

  private isInStore(abs: string): boolean {
    return abs === this.store || abs.startsWith(this.store + path.sep);
  }

  /**
   * Where a move may start — **outside the root is allowed**: collecting from Downloads or the
   * Desktop into the workspace is the point. The absolute path is kept in the journal so undo
   * knows where home is. Only the store itself is off limits.
   */
  private resolveSource(p: string): string {
    const abs = path.resolve(this.root, p);
    if (this.isInStore(abs)) throw new WasnewError("IN_STORE", "cannot touch the .wasnew store: " + p, p);
    return abs;
  }

  /** Root-relative path that must stay inside the root and outside the store */
  private resolveInside(rel: string): string {
    const abs = path.resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new WasnewError("OUTSIDE_ROOT", "path is outside the root: " + rel, rel);
    }
    if (this.isInStore(abs)) throw new WasnewError("IN_STORE", "cannot touch the .wasnew store: " + rel, rel);
    return abs;
  }

  private async ignoreRules() {
    try {
      return parseIgnore(await fs.readFile(path.join(this.root, IGNORE_FILE), "utf8"));
    } catch {
      return [];
    }
  }

  /** Files under `dir`, in readdir order (depth first). Sibling folders are read in parallel. */
  private async walk(dir: string, rules: ReturnType<typeof parseIgnore>): Promise<{ abs: string; rel: string }[]> {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
    const parts = await Promise.all(entries.map(async (e) => {
      if (this.ignoreNames.has(e.name)) return [];
      const abs = path.join(dir, e.name);
      const rel = toPosix(path.relative(this.root, abs));
      if (e.isDirectory()) return ignoredBy(rules, rel, true) ? [] : this.walk(abs, rules);
      return e.isFile() && !ignoredBy(rules, rel) ? [{ abs, rel }] : [];
    }));
    return parts.flat();
  }

  /**
   * Stores a file's content as a blob. Small files are read once and the buffer that is hashed is
   * the one written. Large files are hashed first and copied only if the blob is new; the file can
   * change between the two reads, so the hash of what was actually copied wins.
   */
  private async storeFile(abs: string, statSize: number, ctx: StoreCtx): Promise<{ hash: string; size: number; isNew: boolean }> {
    if (statSize <= SMALL_FILE_MAX) {
      const buf = await fs.readFile(abs);
      const hash = createHash("sha256").update(buf).digest("hex");
      if (!(await this.claim(hash, ctx))) return { hash, size: buf.length, isNew: false };
      const [tmp] = await this.writeTmp(ctx, (t) => fs.writeFile(t, buf));
      return { hash, size: buf.length, isNew: await this.place(tmp, hash, ctx) };
    }
    const first = await hashFile(abs);
    if (ctx.claimed.has(first.hash) || (await exists(this.objPath(first.hash)))) return { ...first, isNew: false };
    const [tmp, copied] = await this.writeTmp(ctx, async (t) => {
      const h = createHash("sha256");
      let size = 0;
      const tap = new Transform({
        transform(chunk: Buffer, _enc, done) { h.update(chunk); size += chunk.length; done(null, chunk); },
      });
      await pipeline(createReadStream(abs), tap, createWriteStream(t));
      return { hash: h.digest("hex"), size };
    });
    if (!(await this.claim(copied.hash, ctx))) {
      await fs.rm(tmp, { force: true });
      return { ...copied, isNew: false };
    }
    return { ...copied, isNew: await this.place(tmp, copied.hash, ctx) };
  }

  /**
   * True if this task should write the blob: no other file of the same capture took it, and it is
   * not stored yet. Marked before the await, so two files with the same new content store it once.
   */
  private async claim(hash: string, ctx: StoreCtx): Promise<boolean> {
    if (ctx.claimed.has(hash)) return false;
    ctx.claimed.add(hash);
    return !(await exists(this.objPath(hash)));
  }

  /** Writes a temp file in the store. tmp/ is made once per capture; gc may clear it, so ENOENT makes it again. */
  private async writeTmp<R>(ctx: StoreCtx, write: (tmp: string) => Promise<R>): Promise<[string, R]> {
    const tmp = path.join(this.tmpDir, randomBytes(8).toString("hex"));
    if (!ctx.made.has(this.tmpDir)) { await fs.mkdir(this.tmpDir, { recursive: true }); ctx.made.add(this.tmpDir); }
    try {
      return [tmp, await write(tmp)];
    } catch (e: any) {
      await fs.rm(tmp, { force: true });
      if (e?.code !== "ENOENT" || (await exists(this.tmpDir))) throw e;
      await fs.mkdir(this.tmpDir, { recursive: true });
      try {
        return [tmp, await write(tmp)];
      } catch (e2) {
        await fs.rm(tmp, { force: true });
        throw e2;
      }
    }
  }

  /**
   * Renames a finished temp file into objects/. Returns false if another writer stored the same
   * blob first: Windows can refuse to rename onto it (EPERM, EEXIST), and that blob is just as good.
   */
  private async place(tmp: string, hash: string, ctx: StoreCtx): Promise<boolean> {
    const dest = this.objPath(hash);
    const dir = path.dirname(dest);
    try {
      if (!ctx.made.has(dir)) { await fs.mkdir(dir, { recursive: true }); ctx.made.add(dir); }
      try {
        await fs.rename(tmp, dest);
      } catch (e: any) {
        if (e?.code !== "ENOENT") throw e;
        await fs.mkdir(dir, { recursive: true });
        await fs.rename(tmp, dest);
      }
      return true;
    } catch (e) {
      await fs.rm(tmp, { force: true });
      if (await exists(dest)) return false;
      throw e;
    }
  }

  private async writeManifest(snap: Snapshot): Promise<void> {
    await fs.writeFile(this.manifestPath(snap.id), JSON.stringify(snap, null, 1), "utf8");
  }

  /**
   * Stat cache for full snapshots: a file whose size and mtime match the last snapshot is not
   * hashed again. Files modified within RACY_MS of a snapshot are left out of the cache — an edit
   * in the same clock tick could keep the mtime, so they get hashed next time (git's "racy" rule).
   */
  private get statCachePath() { return path.join(this.store, "statcache.json"); }
  private async readStatCache(): Promise<StatCache> {
    try {
      const c = JSON.parse(await fs.readFile(this.statCachePath, "utf8")) as StatCache;
      return c && typeof c.files === "object" ? c : { files: {} };
    } catch {
      return { files: {} };
    }
  }

  /**
   * Replaces statcache.json through a temp file. Windows refuses to rename onto a file another
   * process has open or is replacing (EPERM, EACCES, EBUSY), which happens when two snapshots end
   * together, so it retries briefly. If it still cannot, the cache is skipped: it only saves
   * rehashing, and the file there belongs to the other snapshot and is valid on its own. The temp
   * file never stays behind.
   */
  private async writeStatCache(cache: StatCache): Promise<void> {
    const tmp = this.statCachePath + "." + randomBytes(4).toString("hex");
    try {
      await fs.writeFile(tmp, JSON.stringify(cache), "utf8");
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rename(tmp, this.statCachePath);
          return;
        } catch (e: any) {
          if (!["EPERM", "EACCES", "EBUSY"].includes(e?.code)) throw e;
          if (attempt >= 5) return;
          await new Promise((r) => setTimeout(r, 10 * 2 ** attempt));
        }
      }
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  /**
   * The cache's hashes all come from its snapshot's manifest. While that manifest exists its blobs
   * are live for gc (and gc also keeps every blob the cache names), so a cache hit needs no check
   * that its blob is there. Without the manifest each hit checks its blob.
   */
  private async cacheTrusted(cache: StatCache): Promise<boolean> {
    if (typeof cache.snapshot !== "string") return false;
    try { return await exists(this.manifestPath(cache.snapshot)); } catch { return false; }
  }

  private async capture(rels: string[], label: string | undefined, partial: boolean, opts: { cache?: StatCache; trustCache?: boolean; skipIfUnchanged?: boolean } = {}): Promise<SnapshotResult> {
    const files: SnapshotFile[] = new Array(rels.length);
    const stats = new Map<string, { size: number; mtimeMs: number }>();
    let newBlobs = 0, hashed = 0;
    const ctx: StoreCtx = { made: new Set(), claimed: new Set() };
    await eachLimit(rels, CAPTURE_CONCURRENCY, async (rel, i) => {
      const abs = this.resolveInside(rel);
      const st = await fs.stat(abs);
      stats.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
      const known = opts.cache?.files[rel];
      if (known && known[0] === st.size && known[1] === st.mtimeMs && (opts.trustCache || (await exists(this.objPath(known[2]))))) {
        files[i] = { path: rel, hash: known[2], size: st.size };
        return;
      }
      const stored = await this.storeFile(abs, st.size, ctx);
      hashed++;
      files[i] = { path: rel, hash: stored.hash, size: stored.size };
      if (stored.isNew) newBlobs++;
    });
    files.sort((a, b) => byLocale(a.path, b.path));
    if (opts.skipIfUnchanged && opts.cache?.snapshot) {
      const last = await this.get(opts.cache.snapshot).catch(() => null);
      if (last && last.files.length === files.length && last.files.every((f, i) => f.path === files[i].path && f.hash === files[i].hash)) {
        return { id: last.id, label: last.label, created: last.created, fileCount: last.fileCount, newBlobs: 0, hashed, unchanged: true };
      }
    }
    const created = new Date().toISOString();
    const snap: Snapshot = {
      id: snapshotId(created), label, created, fileCount: files.length, files,
      journalSeq: (await this.readJournal()).at(-1)?.seq ?? 0,
      ...(partial ? { partial: true } : {}),
    };
    await this.writeManifest(snap);
    if (!partial) {
      const trustBefore = Date.now() - RACY_MS;
      const cache: StatCache = { snapshot: snap.id, files: {} };
      for (const f of files) {
        const st = stats.get(f.path)!;
        if (st.mtimeMs < trustBefore) cache.files[f.path] = [st.size, st.mtimeMs, f.hash];
      }
      await this.writeStatCache(cache);
    }
    return { id: snap.id, label, created, fileCount: files.length, newBlobs, hashed, ...(partial ? { partial: true } : {}) };
  }

  /**
   * Snapshot of everything under the root (minus ignores). Blobs already stored are not written
   * again, and files unchanged since the last snapshot are not even re-read (`rehash` forces it).
   * `skipIfUnchanged` returns the last snapshot instead of making an identical one.
   */
  async snapshot(opts: { label?: string; include?: (relative: string, size: number) => boolean | Promise<boolean>; rehash?: boolean; skipIfUnchanged?: boolean } = {}): Promise<SnapshotResult> {
    // the stat cache is read while the folder is walked
    const cached = this.readStatCache().then(async (c) => ({ cache: c, trusted: !opts.rehash && (await this.cacheTrusted(c)) }));
    const found = await this.walk(this.root, await this.ignoreRules());
    let rels = found.map((f) => f.rel);
    if (opts.include) {
      // stat in parallel, but ask `include` in walk order, one at a time, as before
      const sizes: number[] = new Array(found.length);
      await eachLimit(found, CAPTURE_CONCURRENCY, async (f, i) => { sizes[i] = (await fs.stat(f.abs)).size; });
      const kept: string[] = [];
      for (let i = 0; i < rels.length; i++) if (await opts.include(rels[i], sizes[i])) kept.push(rels[i]);
      rels = kept;
    }
    const { cache, trusted: trustCache } = await cached;
    return this.capture(rels, opts.label, false, { cache: opts.rehash ? { snapshot: cache.snapshot, files: {} } : cache, trustCache, skipIfUnchanged: opts.skipIfUnchanged });
  }

  /**
   * Snapshots whenever something in the folder changes, after `debounceMs` of quiet — the safety
   * net for programs that don't go through wasnew. Identical states are not stored twice.
   * Stop it with the AbortSignal.
   */
  async watch(opts: { signal?: AbortSignal; debounceMs?: number; label?: string; onSnapshot?: (s: SnapshotResult) => void; onError?: (e: unknown) => void } = {}): Promise<void> {
    const debounceMs = opts.debounceMs ?? 2000;
    let timer: NodeJS.Timeout | undefined;
    let running = Promise.resolve();
    const take = () => {
      timer = undefined;
      running = running.then(async () => {
        if (opts.signal?.aborted) return;
        try {
          const s = await this.snapshot({ label: opts.label ?? "watch", skipIfUnchanged: true });
          if (!s.unchanged) opts.onSnapshot?.(s);
        } catch (e) {
          opts.onError?.(e);
        }
      });
    };
    const watcher = watchFs(this.root, { recursive: true, signal: opts.signal });
    const finished = new Promise<void>((resolve) => {
      watcher.on("close", resolve);
      watcher.on("error", (e: any) => { if (e?.name !== "AbortError") opts.onError?.(e); resolve(); });
    });
    watcher.on("change", (_event, name) => {
      const rel = toPosix(String(name ?? ""));
      if (rel.split("/").some((part) => this.ignoreNames.has(part))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(take, debounceMs);
    });
    opts.signal?.addEventListener("abort", () => { if (timer) clearTimeout(timer); watcher.close(); }, { once: true });
    await finished;
    await running;
  }

  /** Brings in history from elsewhere (e.g. an existing git safety net). Writes no user files. */
  async importSnapshot(id: string, created: string, label: string, entries: { path: string; content: Uint8Array }[]): Promise<void> {
    const manifest = this.manifestPath(id);
    if (await exists(manifest)) return;
    const files: SnapshotFile[] = [];
    for (const entry of entries) {
      this.resolveInside(entry.path);
      const hash = createHash("sha256").update(entry.content).digest("hex");
      const object = this.objPath(hash);
      await fs.mkdir(path.dirname(object), { recursive: true });
      try {
        await fs.writeFile(object, entry.content, { flag: "wx" });
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
      }
      files.push({ path: toPosix(entry.path), hash, size: entry.content.length });
    }
    await this.writeManifest({ id, created, label, fileCount: files.length, files });
  }

  /** A file's content as it was in a snapshot */
  async readSnapshotFile(id: string, rel: string): Promise<Uint8Array> {
    this.resolveInside(rel);
    const snapshot = await this.get(id);
    const file = snapshot.files.find((f) => f.path === toPosix(rel));
    if (!file) throw new WasnewError("NOT_IN_SNAPSHOT", `not in snapshot ${id}: ${rel}`, rel);
    return fs.readFile(this.objPath(file.hash));
  }

  /** Snapshots, newest first */
  async log(): Promise<SnapshotMeta[]> {
    const dir = path.join(this.store, "snapshots");
    const names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json"));
    const metas: SnapshotMeta[] = [];
    for (const n of names) {
      const snap = JSON.parse(await fs.readFile(path.join(dir, n), "utf8")) as Snapshot;
      metas.push({ id: snap.id, label: snap.label, created: snap.created, fileCount: snap.fileCount, ...(snap.partial ? { partial: true } : {}) });
    }
    metas.sort((a, b) => (b.created + b.id).localeCompare(a.created + a.id));
    return metas;
  }

  async get(id: string): Promise<Snapshot> {
    try {
      return JSON.parse(await fs.readFile(this.manifestPath(id), "utf8")) as Snapshot;
    } catch (e: any) {
      if (e?.code === "ENOENT") throw new WasnewError("SNAPSHOT_NOT_FOUND", "no such snapshot: " + id);
      throw e;
    }
  }

  /**
   * Restore — overwrite with the snapshot's content.
   * Files the snapshot doesn't have are **left alone** (there is no restore that deletes).
   * Files about to be overwritten are captured first into a partial "guard" snapshot,
   * so a restore can itself be undone. Pass `guard: false` only if you already snapshotted.
   */
  async restore(id: string, opts: { paths?: string[]; guard?: boolean; guardLabel?: string; by?: Actor } = {}): Promise<RestoreResult> {
    const snap = await this.get(id);
    const want = opts.paths ? new Set(opts.paths.map(toPosix)) : null;
    const todo: { file: SnapshotFile; abs: string; overwrites: boolean }[] = [];
    let skipped = 0;
    for (const file of snap.files) {
      if (want && !want.has(file.path)) continue;
      const abs = this.resolveInside(file.path);
      const current = await hashIfFile(abs);
      if (current === file.hash) { skipped++; continue; }
      todo.push({ file, abs, overwrites: current !== null });
    }
    const overwritten = todo.filter((t) => t.overwrites).map((t) => t.file.path);
    const guard = opts.guard !== false && overwritten.length
      ? (await this.capture(overwritten, opts.guardLabel ?? `before restore ${id}`, true)).id
      : undefined;
    for (const { file, abs } of todo) {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      // write beside the target and rename, so a crash never leaves a half-written file
      const tmp = abs + TMP_PREFIX + randomBytes(4).toString("hex");
      try {
        await fs.copyFile(this.objPath(file.hash), tmp);
        await fs.rename(tmp, abs);
      } catch (e) {
        await fs.rm(tmp, { force: true });
        throw e;
      }
    }
    await this.append({ op: "restore", snapshot: id, paths: opts.paths ?? snap.files.map((f) => f.path), at: new Date().toISOString(), ...(guard ? { guard } : {}), ...(opts.by ? { by: opts.by } : {}) });
    return { restored: todo.length, skipped, ...(guard ? { guard } : {}) };
  }

  /**
   * Compares two snapshots, or a snapshot with the current files when `toId` is omitted.
   * A path that vanished and a path that appeared with the same content count as a move.
   */
  async diff(fromId: string, toId?: string): Promise<Diff> {
    const before = new Map((await this.get(fromId)).files.map((f) => [f.path, f.hash]));
    const after = new Map<string, string>();
    if (toId) {
      for (const f of (await this.get(toId)).files) after.set(f.path, f.hash);
    } else {
      for (const { abs, rel } of await this.walk(this.root, await this.ignoreRules())) {
        after.set(rel, (await hashFile(abs)).hash);
      }
    }
    const changed: string[] = [];
    let missing: string[] = [];
    let added: string[] = [];
    for (const [p, h] of before) {
      if (!after.has(p)) missing.push(p);
      else if (after.get(p) !== h) changed.push(p);
    }
    for (const p of after.keys()) if (!before.has(p)) added.push(p);
    const moved: { from: string; to: string }[] = [];
    const addedByHash = new Map<string, string[]>();
    for (const p of added) {
      const list = addedByHash.get(after.get(p)!) ?? [];
      list.push(p);
      addedByHash.set(after.get(p)!, list);
    }
    const movedFrom = new Set<string>(), movedTo = new Set<string>();
    for (const p of missing) {
      const to = addedByHash.get(before.get(p)!)?.shift();
      if (to) { moved.push({ from: p, to }); movedFrom.add(p); movedTo.add(to); }
    }
    missing = missing.filter((p) => !movedFrom.has(p));
    added = added.filter((p) => !movedTo.has(p));
    const byPath = (a: string, b: string) => a.localeCompare(b);
    return { added: added.sort(byPath), changed: changed.sort(byPath), missing: missing.sort(byPath), moved };
  }

  /**
   * Drops old snapshots and the blobs only they referenced — from the store, never user files.
   * Needs an explicit policy, keeps the newest snapshot no matter what, and is a dry run unless told otherwise.
   */
  async gc(opts: { keepLast?: number; olderThanDays?: number; dryRun?: boolean }): Promise<GcResult> {
    if (opts.keepLast === undefined && opts.olderThanDays === undefined) {
      throw new WasnewError("GC_NEEDS_POLICY", "gc needs keepLast and/or olderThanDays");
    }
    const dryRun = opts.dryRun !== false;
    const snapshots = await this.log();
    const cutoff = opts.olderThanDays === undefined ? null : Date.now() - opts.olderThanDays * 86_400_000;
    const drop = snapshots.filter((s, i) =>
      i > 0 &&
      (opts.keepLast === undefined || i >= opts.keepLast) &&
      (cutoff === null || Date.parse(s.created) < cutoff));
    const dropIds = new Set(drop.map((s) => s.id));
    const live = new Set<string>();
    for (const s of snapshots) {
      if (dropIds.has(s.id)) continue;
      for (const f of (await this.get(s.id)).files) live.add(f.hash);
    }
    // the next snapshot reuses the stat cache's hashes without reading the files, so their blobs
    // stay even when the cache's own snapshot is dropped (that snapshot's manifest still goes)
    for (const known of Object.values((await this.readStatCache()).files)) {
      if (typeof known?.[2] === "string") live.add(known[2]);
    }
    let blobs = 0, bytes = 0;
    const objects = path.join(this.store, "objects");
    const now = Date.now();
    for (const prefix of await fs.readdir(objects).catch(() => [] as string[])) {
      for (const rest of await fs.readdir(path.join(objects, prefix)).catch(() => [] as string[])) {
        if (live.has(prefix + rest)) continue;
        const p = path.join(objects, prefix, rest);
        const st = await fs.stat(p);
        if (now - st.mtimeMs < GC_GRACE_MS) continue;
        blobs++;
        bytes += st.size;
        if (!dryRun) await fs.rm(p);
      }
    }
    if (!dryRun) {
      for (const id of dropIds) await fs.rm(this.manifestPath(id));
      await fs.rm(this.tmpDir, { recursive: true, force: true });
    }
    return { dryRun, snapshots: [...dropIds], blobs, bytes };
  }

  // ── journal ──────────────────────────────────────────────

  async readJournal(): Promise<JournalEntry[]> {
    let src = "";
    try { src = await fs.readFile(this.journalPath, "utf8"); } catch { return []; }
    return src.split("\n").filter(Boolean).map((l) => JSON.parse(l) as JournalEntry);
  }

  /**
   * Next sequence number without rereading the whole journal on every call — moving 3,000
   * files used to read it 3,000 times, O(n²) (measured 2026-09-11: 2,625 moves took 6.6 s,
   * mostly here). If the size is what we last wrote we trust our counter; if another process
   * wrote in between, reread. Only called under the journal lock.
   */
  private lastSeq = 0;
  private seenBytes = -1;
  private async nextSeq(): Promise<number> {
    const size = await fs.stat(this.journalPath).then((st) => st.size, () => 0);
    if (this.seenBytes < 0 || size !== this.seenBytes) {
      const entries = await this.readJournal();
      this.lastSeq = entries.length ? entries[entries.length - 1].seq : 0;
      this.seenBytes = size;
    }
    return this.lastSeq + 1;
  }

  /** Appends under a cross-process lock so two writers can never hand out the same seq */
  private async append(entry: JournalLine): Promise<number> {
    return this.appendMany([entry]);
  }

  /** Several entries with consecutive seqs, under one lock and in one write. Returns the first seq. */
  private async appendMany(entries: JournalLine[]): Promise<number> {
    return withLock(this.lockPath, async () => {
      const first = await this.nextSeq();
      const text = entries.map((e, i) => JSON.stringify({ seq: first + i, ...e }) + "\n").join("");
      await fs.appendFile(this.journalPath, text, "utf8");
      this.seenBytes += Buffer.byteLength(text);
      this.lastSeq = first + entries.length - 1;
      for (const e of entries) if ((e.op === "move" || e.op === "trash") && typeof e.batch === "string" && e.redoOf === undefined) this.countOp(e.batch);
      return first;
    });
  }

  /** Records an app-defined event (e.g. "open") in the journal. Operation names wasnew writes itself are reserved. */
  async note(op: string, data: Record<string, unknown> = {}): Promise<number> {
    if (RESERVED_OPS.has(op)) throw new WasnewError("RESERVED_OP", "reserved journal op: " + op);
    return this.append({ ...data, op, at: new Date().toISOString() });
  }

  /**
   * Group commit. Writes one inflight marker listing every item, then for each in order runs
   * `check` and renames src → dst, then journals what was renamed under one lock and in one write.
   * If the process dies between a rename and the journal write, the marker stays and `recover()`
   * settles it from what is on disk. The lock is not held during the renames, so other writers
   * are not blocked by them. `keepGoing` false stops at the first failure (move, trash); true
   * carries on (undo).
   */
  private async group<T extends InflightItem>(items: T[], check: (item: T) => Promise<boolean>, keepGoing: boolean, made: Set<string>, onDone?: (item: T) => void): Promise<GroupOutcome> {
    const out: GroupOutcome = { done: [], errors: [] };
    if (!items.length) return out;
    // The first item is checked before the marker is written. Nothing of the group ran yet, so it
    // sees the same folder as it would right before its rename, and a single op that fails its
    // check writes no marker at all. `check` returns true when it saw the destination missing or
    // the source present, which already rules out "looks done" without another stat.
    let firstFailed = false, firstProved = false;
    try {
      firstProved = await check(items[0]);
    } catch (error) {
      out.errors.push({ i: 0, error });
      if (!keepGoing || items.length === 1) return out;
      firstFailed = true;
    }
    // An item whose destination is already there and whose source is not looks done before
    // anything ran. recover() must not mistake that for our work, so the marker says so.
    // A first item that failed its check is never renamed; marking it keeps recover off it too.
    const marked: InflightItem[] = await Promise.all(items.map(async ({ src, dst, entry }, i) => {
      const looksDone = i === 0 && firstFailed ? true
        : i === 0 && firstProved ? false
        : (await exists(dst)) && !(await exists(src));
      return { src, dst, entry, ...(looksDone ? { looksDone } : {}) };
    }));
    const file = path.join(this.inflightDir, `${Date.now()}-${process.pid}-${randomBytes(3).toString("hex")}.json`);
    const at = new Date().toISOString();
    await this.writeMarker(file, JSON.stringify({ pid: process.pid, at, items: marked }));
    const tried: number[] = [];   // reached the rename
    const ats: string[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        if (i === 0) { if (firstFailed) continue; }
        else await check(items[i]);
        tried.push(i);
        await this.renameInto(items[i].src, items[i].dst, made);
        out.done.push(i);
        ats.push(new Date().toISOString());
        onDone?.(items[i]);
      } catch (error) {
        out.errors.push({ i, error });
        if (!keepGoing) break;
      }
    }
    if (out.done.length) {
      try {
        await this.appendMany(out.done.map((i, k) => ({ ...items[i].entry, at: ats[k] })));
      } catch (e) {
        out.journalError = e;
      }
    }
    // renamed but not written down (e.g. the journal lock timed out): keep those in the marker for recover()
    const unrecorded = new Set(out.journalError === undefined ? tried.filter((i) => !out.done.includes(i)) : tried);
    const left: InflightItem[] = [];
    if (unrecorded.size) {
      const settled = await this.settle(tried.map((i) => marked[i]));
      tried.forEach((i, k) => { if (unrecorded.has(i) && settled[k] === "done") left.push(marked[i]); });
    }
    if (left.length) await fs.writeFile(file, JSON.stringify({ pid: process.pid, at, items: left }));
    else await fs.rm(file, { force: true });
    return out;
  }

  /** inflight/ is made once per Vault, not per group; if it went away since, make it again */
  private inflightMade = false;
  private async writeMarker(file: string, text: string): Promise<void> {
    if (!this.inflightMade) { await fs.mkdir(this.inflightDir, { recursive: true }); this.inflightMade = true; }
    try {
      await fs.writeFile(file, text);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
      await fs.mkdir(this.inflightDir, { recursive: true });
      await fs.writeFile(file, text);
    }
  }

  /**
   * Judges from disk which marker items were carried out. Walks back from the last item and
   * undoes each done one in a virtual view, so a chain (a→b, then b→c) counts both: b is gone
   * because the later item moved it on. Items that looked done before the group ran never count.
   */
  private async settle(items: InflightItem[]): Promise<("done" | "not-started" | "both-exist" | "missing")[]> {
    const view = new Map<string, boolean>();
    const has = async (p: string) => view.get(p) ?? (await exists(p));
    const result: ("done" | "not-started" | "both-exist" | "missing")[] = new Array(items.length);
    for (let i = items.length - 1; i >= 0; i--) {
      const { src: s, dst: d, looksDone } = items[i];
      const [src, dst] = [await has(s), await has(d)];
      if (looksDone) result[i] = "not-started";
      else if (dst && !src) {
        result[i] = "done";
        view.set(d, false);
        view.set(s, true);
      } else if (src && !dst) result[i] = "not-started";
      else result[i] = src ? "both-exist" : "missing";
    }
    return result;
  }

  /**
   * mkdir once per folder per call (shared by its groups). A folder made earlier can have been
   * moved away by a later op or removed by someone else, so ENOENT on a cached folder makes it
   * again and retries once.
   */
  private async renameInto(fromAbs: string, toAbs: string, made: Set<string>): Promise<void> {
    const dir = path.dirname(toAbs);
    const cached = made.has(dir);
    if (!cached) { await fs.mkdir(dir, { recursive: true }); made.add(dir); }
    try {
      await this.rename(fromAbs, toAbs);
    } catch (e: any) {
      if (!cached || e?.code !== "ENOENT") throw e;
      await fs.mkdir(dir, { recursive: true });
      await this.rename(fromAbs, toAbs);
    }
  }

  // ── policy ──────────────────────────────────────────────

  /** The folder's policy (`.wasnew/policy.json`), re-read when the file changes */
  async policy(): Promise<LoadedPolicy> {
    return this.policyFile.get();
  }

  /** per-batch op counts for policy.maxOpsPerBatch — loaded from the journal once, then kept current by append */
  private batchCounts: Map<string, number> | null = null;
  private countOp(batch: string) {
    this.batchCounts?.set(batch, (this.batchCounts.get(batch) ?? 0) + 1);
  }
  private async opsInBatch(batch: string): Promise<number> {
    if (!this.batchCounts) {
      const counts = new Map<string, number>();
      for (const e of await this.readJournal()) {
        const b = (e as Movement).batch;
        // a redo takes the place of an op the batch already counted
        if ((e.op === "move" || e.op === "trash") && typeof b === "string" && (e as Movement).redoOf === undefined) counts.set(b, (counts.get(b) ?? 0) + 1);
      }
      this.batchCounts = counts;
    }
    return this.batchCounts.get(batch) ?? 0;
  }

  private relInside(abs: string): string | null {
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) return null;
    return toPosix(path.relative(this.root, abs));
  }

  /** A protected path, or a folder holding one, is off limits */
  private async assertUnprotected(p: LoadedPolicy, abs: string): Promise<void> {
    if (!p.policy.protect?.length) return;
    const rel = this.relInside(abs);
    if (rel === null) return;
    if (rel && p.isProtected(rel)) throw new WasnewError("POLICY_PROTECTED", "protected by policy: " + rel, rel);
    const st = await fs.stat(abs).catch(() => null);
    if (!st?.isDirectory()) return;
    for (const child of await fs.readdir(abs, { recursive: true })) {
      const childRel = toPosix(path.join(rel, String(child)));
      if (p.isProtected(childRel)) throw new WasnewError("POLICY_PROTECTED", "folder holds a path protected by policy: " + childRel, childRel);
    }
  }

  /** `pending`: ops of this batch already done in the current group but not yet journaled; null skips the batch limit (redo) */
  private async checkPolicy(p: LoadedPolicy, op: "move" | "trash", fromAbs: string, toAbs: string | null, batch: string | undefined, pending: number | null): Promise<void> {
    await this.assertUnprotected(p, fromAbs);
    if (toAbs) await this.assertUnprotected(p, toAbs);
    if (op === "trash" && p.policy.allowTrash === false) throw new WasnewError("POLICY_DENIED", "trash is turned off by policy");
    const max = p.policy.maxOpsPerBatch;
    if (pending !== null && batch !== undefined && max !== undefined && (await this.opsInBatch(batch)) + pending >= max) {
      throw new WasnewError("POLICY_LIMIT", `batch ${batch} reached the policy limit of ${max} operations`);
    }
  }

  // ── move · trash · undo ─────────────────────────────────

  /**
   * Moves and records. Refuses if the destination exists (no overwrite).
   * Everything that moves files must go through here (or moveMany) for undo to be complete.
   * Pass `batch` to group moves for `undo({ batch })`, and `by` to say who and why.
   */
  async move(fromRel: string, toRel: string, batch?: string, by?: Actor): Promise<void> {
    const r = await this.perform([{ op: "move", from: fromRel, to: toRel }], batch, by);
    if (r.failed) throw r.error;
  }

  /**
   * The delete verb for agents — sets a file or folder aside in `.wasnew/trash` instead of
   * removing it. `undo` puts it back; only a person's `emptyTrash` really deletes.
   * Returns where it went, relative to the store.
   */
  async trash(rel: string, batch?: string, by?: Actor): Promise<string> {
    const r = await this.perform([{ op: "trash", path: rel }], batch, by);
    if (r.failed) throw r.error;
    return r.trashed[0];
  }

  /** Many moves in order, committed in groups. Stops at the first failure; what was done before it stays journaled. */
  async moveMany(moves: { from: string; to: string }[], batch?: string, by?: Actor): Promise<ManyResult> {
    const r = await this.perform(moves.map((m) => ({ op: "move" as const, from: m.from, to: m.to })), batch, by);
    return { done: r.done, ...(r.failed ? { failed: r.failed } : {}) };
  }

  /** Many trashes in order, committed in groups. Stops at the first failure. */
  async trashMany(paths: string[], batch?: string, by?: Actor): Promise<ManyResult> {
    const r = await this.perform(paths.map((p) => ({ op: "trash" as const, path: p })), batch, by);
    return { done: r.done, trashed: r.trashed, ...(r.failed ? { failed: r.failed } : {}) };
  }

  /**
   * Runs moves and trashes in order, GROUP_SIZE at a time, and stops at the first failure.
   * Each op is checked right before its rename (destination taken, source missing, policy), so it
   * sees the folder as the earlier ops of the call left it and nothing is ever overwritten.
   */
  private async perform(ops: PlanOp[], batch?: string, by?: Actor): Promise<{ done: number; trashed: string[]; failed?: OpFailure; error?: unknown }> {
    let done = 0;
    const trashed: string[] = [];
    const fail = (index: number, error: unknown) => ({ done, trashed, failed: failure(index, error), error });
    const made = new Set<string>();
    for (let start = 0; start < ops.length; start += GROUP_SIZE) {
      const chunk = ops.slice(start, start + GROUP_SIZE);
      // resolve paths first (no disk access) so the marker can list the whole group
      const items: PerformItem[] = [];
      let bad: { index: number; error: unknown } | undefined;
      const trashIds = new TrashIds();
      for (let k = 0; k < chunk.length; k++) {
        const op = chunk[k];
        try {
          if (op.op === "move") {
            const src = this.resolveSource(op.from);   // the source may be outside the root
            const dst = this.resolveInside(op.to);     // the destination never is
            // `Report.PDF` → `Report.pdf` looks like "already exists" on Windows/macOS but is the same file, so let the rename through
            const caseOnly = src !== dst && src.toLowerCase() === dst.toLowerCase();
            const entry = { op: "move", from: toPosix(op.from), to: toPosix(op.to), ...(batch ? { batch } : {}), ...(by ? { by } : {}) };
            items.push({ kind: "move", src, dst, entry, caseOnly, rel: op.to });
          } else {
            const src = this.resolveInside(op.path);
            if (src === this.root) throw new WasnewError("POLICY_DENIED", "cannot trash the whole folder");
            const from = toPosix(path.relative(this.root, src));
            const to = `trash/${trashIds.for(from)}/${from}`;
            const entry = { op: "trash", from, to, ...(batch ? { batch } : {}), ...(by ? { by } : {}) };
            items.push({ kind: "trash", src, dst: path.join(this.store, to), entry, caseOnly: false, rel: op.path, storeTo: to });
          }
        } catch (error) {
          bad = { index: start + k, error };
          break;
        }
      }
      let policy: LoadedPolicy | undefined;
      let pending = 0;
      const out = await this.group(items, async (item) => {
        if (item.kind === "move") {
          if (!item.caseOnly && (await exists(item.dst))) throw new WasnewError("DEST_EXISTS", "destination already exists: " + item.rel, item.rel);
          // lessons tell folders from files without an extension; only those names cost a stat
          if (!hasExt(item.src) && (await fs.stat(item.src).then((st) => st.isDirectory(), () => false))) item.entry.dir = true;
        } else {
          const st = await fs.stat(item.src).catch(() => null);
          if (!st) throw new WasnewError("NOT_FOUND", "no such file: " + item.rel, item.rel);
          if (st.isDirectory()) item.entry.dir = true;
        }
        policy ??= await this.policy();   // once per group, read when the first op gets this far
        await this.checkPolicy(policy, item.kind, item.src, item.kind === "move" ? item.dst : null, batch, pending);
        return !item.caseOnly;   // saw the destination missing (move) or the source present (trash)
      }, false, made, () => { pending++; });
      if (out.journalError !== undefined) return fail(start + out.done[0], out.journalError);
      done += out.done.length;
      for (const i of out.done) if (items[i].storeTo) trashed.push(items[i].storeTo!);
      if (out.errors.length) return fail(start + out.errors[0].i, out.errors[0].error);
      if (bad) return fail(bad.index, bad.error);
    }
    return { done, trashed };
  }

  /**
   * Really deletes trash older than `olderThanDays` — the one operation that removes user content,
   * meant for a person (it is not an MCP tool). Dry run unless told otherwise.
   */
  async emptyTrash(opts: { olderThanDays: number; dryRun?: boolean }): Promise<TrashPurge> {
    const dryRun = opts.dryRun !== false;
    const cutoff = Date.now() - opts.olderThanDays * 86_400_000;
    const old = (await this.activeMoves()).filter((m): m is JournalTrash => m.op === "trash" && Date.parse(m.at) <= cutoff);
    let bytes = 0;
    for (const m of old) bytes += await sizeOf(this.trashPath(m.to));
    if (!dryRun && old.length) {
      for (const m of old) {
        await fs.rm(this.trashPath(m.to), { recursive: true, force: true });
        await this.pruneEmptyDirs(path.dirname(this.trashPath(m.to)), this.trashDir);
      }
      await this.append({ op: "purge", of: old.map((m) => m.seq), at: new Date().toISOString() });
    }
    return { dryRun, entries: old.map((m) => ({ from: m.from, to: m.to, at: m.at })), bytes };
  }

  private trashPath(storeRel: string): string {
    const abs = path.resolve(this.store, storeRel);
    if (!abs.startsWith(this.trashDir + path.sep)) throw new WasnewError("IN_STORE", "not a trash path: " + storeRel, storeRel);
    return abs;
  }

  /**
   * Same volume: just a rename. Across volumes (EXDEV): copy → verify → delete the original.
   * The original is **never** removed before the copy is verified; an interruption leaves a
   * duplicate, not a loss. Folders would need recursive copy with progress, so they are refused.
   */
  private async rename(fromAbs: string, toAbs: string): Promise<void> {
    try {
      await fs.rename(fromAbs, toAbs);
      return;
    } catch (e: any) {
      if (e?.code !== "EXDEV") throw e;
    }
    if ((await fs.stat(fromAbs)).isDirectory()) {
      throw new WasnewError("CROSS_DEVICE_DIR", "folders cannot be moved across drives; move the files instead", fromAbs);
    }
    const tmp = toAbs + TMP_PREFIX + randomBytes(4).toString("hex");
    try {
      await fs.copyFile(fromAbs, tmp);
      // size first — cheap, and if it differs there is no need to hash
      const [a, b] = await Promise.all([fs.stat(fromAbs), fs.stat(tmp)]);
      if (a.size !== b.size || (await hashFile(fromAbs)).hash !== (await hashFile(tmp)).hash) {
        throw new WasnewError("COPY_MISMATCH", "copy differs from the original; the original was left in place", fromAbs);
      }
      await fs.rename(tmp, toAbs);          // same volume as tmp, so atomic
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
    await fs.rm(fromAbs);
  }

  private async activeMoves(): Promise<Movement[]> {
    const entries = await this.readJournal();
    const gone = new Set<number>();
    for (const e of entries) {
      if (e.op === "undo") gone.add((e as JournalUndo).of);
      else if (e.op === "purge") for (const seq of (e as JournalNote).of as number[]) gone.add(seq);
    }
    return entries.filter((e): e is Movement => (e.op === "move" || e.op === "trash") && !gone.has(e.seq));
  }

  /** Moves and trashes not yet undone, newest first */
  async pendingMoves(batch?: string): Promise<MoveRecord[]> {
    return (await this.activeMoves())
      .filter((m) => batch === undefined || m.batch === batch)
      .reverse()
      .map(record);
  }

  /**
   * Undoes moves and trashes newest-first: the last `count` overall, or of one `batch` (other
   * moves in between are untouched). Never overwrites — if something now sits at the original
   * place, that move is skipped and reported. Undo itself is journaled.
   */
  async undo(opts: { batch?: string; count?: number; by?: Actor } = {}): Promise<UndoResult> {
    const active = await this.activeMoves();
    const count = opts.count && opts.count > 0 ? opts.count : opts.batch ? Infinity : 1;
    const targets = (opts.batch === undefined ? active : active.filter((m) => m.batch === opts.batch)).slice(-count).reverse();
    const undone: MoveRecord[] = [];
    const skipped: UndoSkip[] = [];
    const made = new Set<string>();
    for (let start = 0; start < targets.length; start += GROUP_SIZE) {
      const chunk = targets.slice(start, start + GROUP_SIZE);
      const items: UndoItem[] = [];
      const skips = new Map<Movement, { reason: string; message: string }>();
      const why = (e: any, fallback: string) => ({ reason: e?.code ?? fallback, message: String(e?.message ?? e) });
      const missing = (item: UndoItem) => ({ code: "MISSING", message: "the moved file is no longer there: " + item.m.to });
      for (const m of chunk) {
        try {
          const moved = m.op === "trash" ? this.trashPath(m.to) : this.resolveInside(m.to);
          const origin = m.op === "trash" ? this.resolveInside(m.from) : this.resolveSource(m.from);   // what came from a source goes back to it
          const caseOnly = origin !== moved && origin.toLowerCase() === moved.toLowerCase();   // a case-only rename: the original place is the file itself
          items.push({ m, src: moved, dst: origin, caseOnly, entry: { op: "undo", of: m.seq, ...(opts.by ? { by: opts.by } : {}) } });
        } catch (e) {
          skips.set(m, why(e, "INVALID"));
        }
      }
      const out = await this.group(items, async (item) => {
        if (!item.caseOnly && (await exists(item.dst))) throw { code: "ORIGIN_OCCUPIED", message: "something now exists at the original place: " + item.m.from };
        // a case-only undo checks its source here; otherwise a missing source fails the rename with ENOENT
        if (item.caseOnly && !(await exists(item.src))) throw missing(item);
        return true;   // saw the original place free, or the source present
      }, true, made);
      for (const { i, error } of out.errors) skips.set(items[i].m, why((error as any)?.code === "ENOENT" ? missing(items[i]) : error, "ERROR"));
      const journaled = out.journalError === undefined ? out.done : [];
      if (out.journalError !== undefined) for (const i of out.done) skips.set(items[i].m, why(out.journalError, "ERROR"));
      const ok = new Set(journaled.map((i) => items[i].m));
      for (const m of chunk) {
        if (ok.has(m)) undone.push(record(m));
        else skipped.push({ ...record(m), ...skips.get(m)! });
      }
      // folders the moves created go away once empty: each folder once, deepest first
      const dirs = new Map<string, string>();
      for (const i of journaled) dirs.set(path.dirname(items[i].src), items[i].m.op === "trash" ? this.trashDir : this.root);
      const deepestFirst = [...dirs].sort((a, b) => b[0].split(path.sep).length - a[0].split(path.sep).length);
      for (const [dir, stopAt] of deepestFirst) await this.pruneEmptyDirs(dir, stopAt);
    }
    return { undone, skipped };
  }

  /** Undo one whole apply — safe even if other moves happened in between */
  async undoBatch(batch: string): Promise<MoveRecord[]> {
    return (await this.undo({ batch })).undone;
  }

  /** Undo only the **last `count`** moves of a batch — one wrong move out of 512 shouldn't cost all 512 */
  async undoLast(batch: string, count: number): Promise<MoveRecord[]> {
    return (await this.undo({ batch, count })).undone;
  }

  /** Undo the last `count` moves, newest first */
  async undoMoves(count = 1): Promise<MoveRecord[]> {
    return (await this.undo({ count })).undone;
  }

  /**
   * Re-applies undone moves and trashes: those of one `batch`, or the last `count` undone overall,
   * most recently undone first (the reverse of how undo took them back, so a chain replays in its
   * first order). Each one is journaled as a new move or trash with `redoOf`, through the same
   * group commit as any move, so a crash is settled by recover() and `undo` can take the redo back.
   * The original op stays undone. Never overwrites: a taken destination or a missing source is
   * skipped and reported, as in undo. Protected paths and allowTrash still apply; maxOpsPerBatch
   * does not, since the batch already counted the op.
   */
  async redo(opts: { batch?: string; count?: number; by?: Actor } = {}): Promise<RedoResult> {
    const entries = await this.readJournal();
    const undoneBy = new Map<number, number>();
    const redone = new Set<number>();
    for (const e of entries) {
      if (e.op === "undo") undoneBy.set((e as JournalUndo).of, e.seq);
      else if ((e.op === "move" || e.op === "trash") && typeof (e as Movement).redoOf === "number") redone.add((e as Movement).redoOf!);
    }
    const candidates = entries
      .filter((e): e is Movement => (e.op === "move" || e.op === "trash") && undoneBy.has(e.seq) && !redone.has(e.seq))
      .filter((m) => opts.batch === undefined || m.batch === opts.batch)
      .sort((a, b) => undoneBy.get(a.seq)! - undoneBy.get(b.seq)!);
    const count = opts.count && opts.count > 0 ? opts.count : opts.batch ? Infinity : 1;
    const targets = candidates.slice(-count).reverse();
    const out: RedoResult = { redone: [], skipped: [] };
    const made = new Set<string>();
    const why = (e: any, fallback: string) => ({ reason: e?.code ?? fallback, message: String(e?.message ?? e) });
    const missing = (item: RedoItem) => ({ code: "MISSING", message: "the file is no longer at " + item.m.from });
    for (let start = 0; start < targets.length; start += GROUP_SIZE) {
      const chunk = targets.slice(start, start + GROUP_SIZE);
      const items: RedoItem[] = [];
      const skips = new Map<Movement, { reason: string; message: string }>();
      const trashIds = new TrashIds();
      for (const m of chunk) {
        try {
          const by = opts.by ?? m.by;
          const tail = { ...(m.batch ? { batch: m.batch } : {}), ...(by ? { by } : {}), redoOf: m.seq, ...(m.dir ? { dir: true } : {}) };
          if (m.op === "move") {
            const src = this.resolveSource(m.from), dst = this.resolveInside(m.to);
            const caseOnly = src !== dst && src.toLowerCase() === dst.toLowerCase();
            items.push({ m, src, dst, caseOnly, entry: { op: "move", from: m.from, to: m.to, ...tail } });
          } else {
            const src = this.resolveInside(m.from);
            const from = toPosix(path.relative(this.root, src));
            const to = `trash/${trashIds.for(from)}/${from}`;
            items.push({ m, src, dst: path.join(this.store, to), caseOnly: false, storeTo: to, entry: { op: "trash", from, to, ...tail } });
          }
        } catch (e) {
          skips.set(m, why(e, "INVALID"));
        }
      }
      let policy: LoadedPolicy | undefined;
      const result = await this.group(items, async (item) => {
        if (item.m.op === "move" && !item.caseOnly && (await exists(item.dst))) throw { code: "DEST_EXISTS", message: "something now exists at the destination: " + item.m.to };
        // a trash or case-only move checks its source here; otherwise a missing source fails the rename with ENOENT
        if ((item.caseOnly || item.m.op === "trash") && !(await exists(item.src))) throw missing(item);
        policy ??= await this.policy();
        await this.checkPolicy(policy, item.m.op, item.src, item.m.op === "move" ? item.dst : null, item.m.batch, null);
        return true;
      }, true, made);
      for (const { i, error } of result.errors) skips.set(items[i].m, why((error as any)?.code === "ENOENT" ? missing(items[i]) : error, "ERROR"));
      const journaled = result.journalError === undefined ? result.done : [];
      if (result.journalError !== undefined) for (const i of result.done) skips.set(items[i].m, why(result.journalError, "ERROR"));
      const at = new Date().toISOString();
      const ok = new Map(journaled.map((i) => [items[i].m, items[i]]));
      for (const m of chunk) {
        const item = ok.get(m);
        if (item) out.redone.push({ ...record(m), at, ...(item.storeTo ? { to: item.storeTo } : {}), ...(item.entry.by ? { by: item.entry.by as Actor } : {}) });
        else out.skipped.push({ ...record(m), ...skips.get(m)! });
      }
    }
    return out;
  }

  /** Removes now-empty folders up toward `stopAt` — best effort; only empty folders can go */
  private async pruneEmptyDirs(dirAbs: string, stopAt = this.root): Promise<void> {
    let cur = dirAbs;
    while (cur !== stopAt && cur.startsWith(stopAt + path.sep)) {
      try { await fs.rmdir(cur); } catch { return; }   // refuses a folder that is not empty
      cur = path.dirname(cur);
    }
  }

  // ── plan → approve → apply ───────────────────────────────

  private planPath(id: string): string {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new WasnewError("PLAN_NOT_FOUND", "no such plan: " + id);
    return path.join(this.plansDir, id + ".json");
  }

  /**
   * Checks operations against the folder as it would be after each previous one — missing
   * sources, taken destinations (also within the plan), protected paths, policy limits.
   * Touches nothing.
   */
  private async check(ops: PlanOp[]): Promise<PlanIssue[]> {
    const p = await this.policy();
    const issues: PlanIssue[] = [];
    const added = new Set<string>(), removed = new Set<string>();
    const present = async (abs: string) => added.has(abs) || (!removed.has(abs) && (await exists(abs)));
    for (let index = 0; index < ops.length; index++) {
      const op = ops[index];
      try {
        if (op?.op === "move" && typeof op.from === "string" && typeof op.to === "string") {
          const fromAbs = this.resolveSource(op.from);
          const toAbs = this.resolveInside(op.to);
          if (!(await present(fromAbs))) throw new WasnewError("NOT_FOUND", "no such file: " + op.from, op.from);
          const caseOnly = fromAbs !== toAbs && fromAbs.toLowerCase() === toAbs.toLowerCase();
          if (!caseOnly && (await present(toAbs))) throw new WasnewError("DEST_EXISTS", "destination already exists: " + op.to, op.to);
          await this.assertUnprotected(p, fromAbs);
          await this.assertUnprotected(p, toAbs);
          removed.add(fromAbs); added.delete(fromAbs);
          added.add(toAbs); removed.delete(toAbs);
        } else if (op?.op === "trash" && typeof op.path === "string") {
          const abs = this.resolveInside(op.path);
          if (abs === this.root) throw new WasnewError("POLICY_DENIED", "cannot trash the whole folder");
          if (!(await present(abs))) throw new WasnewError("NOT_FOUND", "no such file: " + op.path, op.path);
          if (p.policy.allowTrash === false) throw new WasnewError("POLICY_DENIED", "trash is turned off by policy");
          await this.assertUnprotected(p, abs);
          removed.add(abs); added.delete(abs);
        } else {
          throw new WasnewError("PLAN_INVALID", "each op must be {op:'move',from,to} or {op:'trash',path}");
        }
      } catch (e: any) {
        issues.push({ index, code: e?.code ?? "ERROR", message: String(e?.message ?? e) });
      }
    }
    const max = p.policy.maxOpsPerBatch;
    if (max !== undefined && ops.length > max) {
      issues.push({ index: max, code: "POLICY_LIMIT", message: `the plan has ${ops.length} operations; policy allows ${max} per batch` });
    }
    return issues;
  }

  /** Proposes operations without touching anything. Save the id: `apply` runs exactly these. */
  async plan(ops: PlanOp[], opts: { by?: Actor } = {}): Promise<Plan> {
    const issues = await this.check(ops);
    const limit = await this.approvalLimit(opts.by?.agent);
    const created = new Date().toISOString();
    const id = createHash("sha256").update(JSON.stringify(ops) + created + randomBytes(8).toString("hex")).digest("hex").slice(0, 16);
    const plan: Plan = { id, created, ops, issues, needsApproval: limit !== undefined && ops.length > limit, ...(opts.by ? { by: opts.by } : {}) };
    await fs.mkdir(this.plansDir, { recursive: true });
    await fs.writeFile(this.planPath(id), JSON.stringify(plan, null, 1), "utf8");
    await this.append({ op: "plan", plan: id, ops: ops.length, issues: issues.length, at: created, ...(opts.by ? { by: opts.by } : {}) });
    return plan;
  }

  async getPlan(id: string): Promise<Plan> {
    try {
      return JSON.parse(await fs.readFile(this.planPath(id), "utf8")) as Plan;
    } catch (e: any) {
      if (e?.code === "ENOENT") throw new WasnewError("PLAN_NOT_FOUND", "no such plan: " + id);
      throw e;
    }
  }

  /** Plans, newest first */
  async plans(): Promise<Plan[]> {
    const names = await fs.readdir(this.plansDir).catch(() => [] as string[]);
    const list = await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => this.getPlan(n.slice(0, -5))));
    return list.sort((a, b) => b.created.localeCompare(a.created));
  }

  /** A person's go-ahead for a plan. Deliberately not an MCP tool — the agent proposes, a person approves. */
  async approve(id: string, by?: string): Promise<Plan> {
    const plan = await this.getPlan(id);
    if (plan.applied) throw new WasnewError("PLAN_APPLIED", "plan was already applied: " + id);
    plan.approved = { at: new Date().toISOString(), ...(by ? { by } : {}) };
    await fs.writeFile(this.planPath(id), JSON.stringify(plan, null, 1), "utf8");
    await this.append({ op: "approve", plan: id, at: plan.approved.at, ...(by ? { by: { agent: by } } : {}) });
    return plan;
  }

  /**
   * Runs exactly the planned operations, once, as one batch. Re-checks the folder first and
   * refuses if anything changed; stops at the first failure (undo the batch to roll back).
   */
  async apply(id: string, opts: { batch?: string; by?: Actor } = {}): Promise<ApplyResult> {
    const plan = await this.getPlan(id);
    if (plan.applied) throw new WasnewError("PLAN_APPLIED", "plan was already applied: " + id);
    if (plan.issues.length) throw new WasnewError("PLAN_INVALID", `plan has ${plan.issues.length} issue(s); make a new plan`);
    const limit = await this.approvalLimit(plan.by?.agent);
    if (limit !== undefined && plan.ops.length > limit && !plan.approved) {
      throw new WasnewError("NEEDS_APPROVAL", `plan ${id} has ${plan.ops.length} operations; policy wants a person to approve more than ${limit} (wasnew approve ${id})`);
    }
    const fresh = await this.check(plan.ops);
    if (fresh.length) throw new WasnewError("PLAN_INVALID", `the folder changed since the plan: ${fresh[0].code} at operation ${fresh[0].index}`);
    const batch = opts.batch ?? "plan-" + id;
    const by = opts.by ?? plan.by;
    const { done, failed } = await this.perform(plan.ops, batch, by);
    plan.applied = { at: new Date().toISOString(), batch };
    await fs.writeFile(this.planPath(id), JSON.stringify(plan, null, 1), "utf8");
    await this.append({ op: "apply", plan: id, batch, done, at: plan.applied.at, ...(by ? { by } : {}) });
    return { plan: id, batch, done, ...(failed ? { failed } : {}) };
  }

  // ── lessons · agents · trust ────────────────────────────

  /**
   * Every move and trash an agent started, with whether it ended up undone. Redo entries are
   * folded into the op they re-apply: it counts as undone only if the last redo was undone too.
   */
  private settledOps(entries: JournalEntry[]): { m: Movement; undone: boolean; latest: Movement }[] {
    const undone = new Set<number>();
    const redoneBy = new Map<number, Movement>();
    for (const e of entries) {
      if (e.op === "undo") undone.add((e as JournalUndo).of);
      else if ((e.op === "move" || e.op === "trash") && typeof (e as Movement).redoOf === "number") redoneBy.set((e as Movement).redoOf!, e as Movement);
    }
    const out: { m: Movement; undone: boolean; latest: Movement }[] = [];
    for (const e of entries) {
      if ((e.op !== "move" && e.op !== "trash") || (e as Movement).redoOf !== undefined) continue;
      let latest = e as Movement;
      for (let hops = 0; undone.has(latest.seq) && redoneBy.has(latest.seq) && hops < entries.length; hops++) latest = redoneBy.get(latest.seq)!;
      out.push({ m: e as Movement, undone: undone.has(latest.seq), latest });
    }
    return out;
  }

  /**
   * The pattern of one op. A name without an extension is a folder when the journal says so;
   * entries written before wasnew recorded that are looked up at `whereNow`.
   */
  private async patternOf(op: "move" | "trash", from: string, to: string | null, whereNow: string, dir?: boolean): Promise<PatternShape> {
    const fromKey = this.journalKey(from);
    const base = fromKey.slice(fromKey.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    let ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
    if (!ext && (dir ?? (await fs.stat(whereNow).then((st) => st.isDirectory(), () => false)))) ext = "folder";
    const dirOf = (k: string) => { const i = k.lastIndexOf("/"); return i < 0 ? "./" : k.slice(0, i + 1); };
    const fromDir = dirOf(fromKey);
    const toDir = to === null ? "trash" : dirOf(this.journalKey(to));
    const fold = process.platform === "win32" || process.platform === "darwin";
    const key = [op, ext, fromDir, toDir].join("\n");
    return { key: fold ? key.toLowerCase() : key, op, ext, fromDir, toDir };
  }

  private async patterns(entries: JournalEntry[]): Promise<Pattern[]> {
    const map = new Map<string, Pattern>();
    for (const { m, undone, latest } of this.settledOps(entries)) {
      const now = undone ? path.resolve(this.root, m.from) : m.op === "trash" ? path.resolve(this.store, latest.to) : path.resolve(this.root, m.to);
      const shape = await this.patternOf(m.op, m.from, m.op === "move" ? m.to : null, now, m.dir);
      let p = map.get(shape.key);
      if (!p) map.set(shape.key, p = { ...shape, total: 0, undone: 0, agents: new Set(), reasons: [], first: m.at, last: m.at });
      p.total++;
      if (m.by?.agent) p.agents.add(m.by.agent);
      if (m.at < p.first) p.first = m.at;
      if (m.at > p.last) p.last = m.at;
      if (undone) {
        p.undone++;
        const r = m.by?.reason;
        if (r) p.reasons.unshift(r.length > REASON_MAX ? r.slice(0, REASON_MAX - 3) + "..." : r);
      }
    }
    return [...map.values()];
  }

  private lesson(p: Pattern, kind: "avoid" | "ok"): Lesson {
    const what = p.ext === "folder" ? "folders" : p.ext ? `*.${p.ext}` : "files without an extension";
    const agents = [...p.agents];
    const reasons = [...new Set(p.reasons)].slice(0, 2);
    const kept = p.total - p.undone;
    const who = agents.length ? ` (${agents.join(", ")})` : "";
    const line = kind === "avoid"
      ? `avoid: ${p.op === "move" ? `moving ${what} from ${p.fromDir} to ${p.toDir}` : `trashing ${what} in ${p.fromDir}`} was undone ${p.undone} of ${p.total} times${who}${reasons.length ? `, last reason "${reasons[0]}"` : ""}`
      : `ok: ${p.op === "move" ? `${what} ${p.fromDir} → ${p.toDir}` : `trashing ${what} in ${p.fromDir}`} kept ${kept} of ${p.total}`;
    return { kind, op: p.op, ext: p.ext, fromDir: p.fromDir, toDir: p.toDir, total: p.total, undone: p.undone, kept, agents, reasons, first: p.first, last: p.last, line };
  }

  private static isAvoid(p: Pattern, minUndone: number): boolean {
    return p.undone >= minUndone && p.undone / p.total >= 0.5;
  }

  /**
   * What the journal says about kinds of operations in this folder: patterns people undid
   * (`avoid`) and patterns they kept (`ok`), each list at most `limit` long. One journal read.
   */
  async lessons(opts: { minUndone?: number; limit?: number } = {}): Promise<Lessons> {
    const minUndone = opts.minUndone ?? 2;
    const limit = opts.limit ?? 10;
    const patterns = await this.patterns(await this.readJournal());
    const cutoff = new Date(Date.now() - CONFIRMED_AFTER_MS).toISOString();
    const avoid = patterns.filter((p) => Vault.isAvoid(p, minUndone))
      .sort((a, b) => b.undone - a.undone || b.last.localeCompare(a.last))
      .slice(0, limit).map((p) => this.lesson(p, "avoid"));
    const ok = patterns.filter((p) => p.total >= 5 && p.undone === 0 && p.first <= cutoff)
      .sort((a, b) => b.total - a.total || b.last.localeCompare(a.last))
      .slice(0, limit).map((p) => this.lesson(p, "ok"));
    return { avoid, ok };
  }

  /** Avoid lessons that match operations of a list about to be run, with how many ops each matches */
  async lessonsFor(ops: PlanOp[], opts: { minUndone?: number } = {}): Promise<PlanLesson[]> {
    const minUndone = opts.minUndone ?? 2;
    const avoid = (await this.patterns(await this.readJournal())).filter((p) => Vault.isAvoid(p, minUndone));
    if (!avoid.length) return [];
    const byKey = new Map(avoid.map((p) => [p.key, p]));
    const matches = new Map<string, number>();
    for (const op of ops) {
      const from = op?.op === "move" ? op.from : op?.op === "trash" ? op.path : undefined;
      if (typeof from !== "string" || (op.op === "move" && typeof op.to !== "string")) continue;
      const { key } = await this.patternOf(op.op, from, op.op === "move" ? op.to : null, path.resolve(this.root, from));
      if (byKey.has(key)) matches.set(key, (matches.get(key) ?? 0) + 1);
    }
    return [...matches].map(([key, n]) => ({ ...this.lesson(byKey.get(key)!, "avoid"), matches: n })).sort((a, b) => b.undone - a.undone);
  }

  /** Each agent's record from the journal: ops started, how many ended up undone, first and last seen */
  async agents(): Promise<AgentRecord[]> {
    const map = new Map<string, AgentRecord>();
    for (const { m, undone } of this.settledOps(await this.readJournal())) {
      const agent = m.by?.agent || "unknown";
      let a = map.get(agent);
      if (!a) map.set(agent, a = { agent, ops: 0, undone: 0, undoRate: 0, firstSeen: m.at, lastSeen: m.at });
      a.ops++;
      if (undone) a.undone++;
      if (m.at < a.firstSeen) a.firstSeen = m.at;
      if (m.at > a.lastSeen) a.lastSeen = m.at;
    }
    for (const a of map.values()) a.undoRate = a.undone / a.ops;
    return [...map.values()].sort((a, b) => b.ops - a.ops || a.agent.localeCompare(b.agent));
  }

  /**
   * How many operations `agent` may run without a person's approval: policy.requireApprovalOver,
   * raised to trust.approvalOver for an agent whose record meets policy.trust. Never lowered, and
   * never raised for an agent the journal cannot name. undefined means no limit.
   */
  async approvalLimit(agent?: string): Promise<number | undefined> {
    const { policy } = await this.policy();
    const base = policy.requireApprovalOver;
    const t = policy.trust;
    if (base === undefined || !t || !agent || agent === "unknown" || t.approvalOver <= base) return base;
    const rec = (await this.agents()).find((a) => a.agent === agent);
    return rec && rec.ops >= t.minOps && rec.undoRate <= t.maxUndoRate ? t.approvalOver : base;
  }

  // ── history · recover ───────────────────────────────────

  /** Everything the journal knows about a path and the names it had before or after — who, when, why */
  async history(rel: string): Promise<HistoryEvent[]> {
    const entries = await this.readJournal();
    const names = new Set([toPosix(rel).replace(/^\.\//, "")]);
    const movements = entries.filter((e): e is Movement => e.op === "move" || e.op === "trash");
    for (const m of [...movements].reverse()) if (names.has(m.to)) names.add(m.from);   // earlier names
    for (const m of movements) if (names.has(m.from)) names.add(m.to);                  // later names
    const included = new Set<number>();
    const undone = new Set(entries.filter((e) => e.op === "undo").map((e) => (e as JournalUndo).of));
    const events: HistoryEvent[] = [];
    for (const e of entries) {
      const n = e as JournalNote;
      const base = { seq: e.seq, op: e.op, at: e.at, ...(n.by ? { by: n.by as Actor } : {}) };
      if (e.op === "move" || e.op === "trash") {
        const m = e as Movement;
        if (!names.has(m.from) && !names.has(m.to)) continue;
        included.add(m.seq);
        events.push({ ...base, from: m.from, to: m.to, ...(m.batch ? { batch: m.batch } : {}), ...(undone.has(m.seq) ? { undone: true } : {}) });
      } else if (e.op === "undo") {
        if (included.has((e as JournalUndo).of)) events.push(base);
      } else if (e.op === "restore") {
        const r = e as JournalRestore;
        if (r.paths.some((p) => names.has(p))) events.push({ ...base, to: r.snapshot });
      } else if (typeof n.path === "string" && names.has(n.path)) {
        events.push(base);
      }
    }
    return events;
  }

  /** Follows a path forward through the journal to where its file is now (see WhereResult) */
  async where(rel: string): Promise<WhereResult> {
    return (await this.whereMany([rel]))[0];
  }

  /**
   * where() for several paths with one journal read. Each path is one pass over the journal:
   * moves of the path or a folder holding it carry it along, an undo carries it back, a trash
   * ends the chain unless undone, a purge of that trash ends it for good.
   */
  async whereMany(rels: string[]): Promise<WhereResult[]> {
    const entries = await this.readJournal();
    // normalized once for all paths: path.resolve per entry is most of the cost
    const keys = new Map<number, { from: string; to: string }>();
    for (const e of entries) {
      if (e.op === "move") keys.set(e.seq, { from: this.journalKey((e as JournalMove).from), to: this.journalKey((e as JournalMove).to) });
      else if (e.op === "trash") keys.set(e.seq, { from: this.journalKey((e as JournalTrash).from), to: (e as JournalTrash).to });   // store-relative already
    }
    return Promise.all(rels.map(async (rel) => {
      const start = this.journalKey(rel);
      const { steps, cur, inTrash, purged, placed } = this.forward(entries, keys, start);
      const by = placed ? { at: placed.at, ...(placed.by ? { by: placed.by } : {}), ...(placed.batch ? { batch: placed.batch } : {}) } : {};
      const out = (r: Omit<WhereResult, "path" | "steps">): WhereResult => ({ path: start, ...r, steps });
      if (await exists(path.resolve(this.root, start))) return out({ status: "here" });
      if (purged) return out({ status: "purged" });
      if (inTrash) {
        if (await exists(path.resolve(this.store, inTrash.path))) return out({ status: "trashed", current: inTrash.path, ...by });
        return out({ status: "unknown", current: inTrash.path, missing: true });
      }
      if (!steps.length) return out({ status: "unknown" });
      if (await exists(path.resolve(this.root, cur))) return out({ status: "moved", current: cur, ...by });
      return out({ status: "unknown", current: cur, missing: true });
    }));
  }

  /** Journal paths are stored as the caller gave them; compare them root-relative (absolute when outside) */
  private journalKey(p: string): string {
    const abs = path.resolve(this.root, p);
    return this.relInside(abs) ?? toPosix(abs);
  }

  private forward(entries: JournalEntry[], keys: Map<number, { from: string; to: string }>, start: string) {
    const fold = process.platform === "win32" || process.platform === "darwin";
    // "" when p is `dir`, "/rest" when p is inside it, null otherwise
    const under = (p: string, dir: string): string | null => {
      const a = fold ? p.toLowerCase() : p, b = fold ? dir.toLowerCase() : dir;
      if (a === b) return "";
      return a.startsWith(b + "/") ? p.slice(dir.length) : null;
    };
    const steps: WhereStep[] = [];
    const live: WhereStep[] = [];   // moves and trashes of this path not undone since
    const trashes = new Set<number>();
    let cur = start;
    let inTrash: { seq: number; path: string } | undefined;
    let purged = false;
    const step = (e: JournalEntry, op: WhereStep["op"], from: string, to: string | undefined, m?: Movement) => {
      const by = (e as JournalNote).by as Actor | undefined;
      const batch = m?.batch;
      const s: WhereStep = { seq: e.seq, op, from, ...(to !== undefined ? { to } : {}), at: e.at, ...(by ? { by } : {}), ...(batch ? { batch } : {}) };
      steps.push(s);
      if (op === "move" || op === "trash") live.push(s);
      else if (op === "undo") { const i = live.findIndex((x) => x.seq === (e as JournalUndo).of); if (i >= 0) live.splice(i, 1); }
    };
    for (const e of entries) {
      if (purged) break;
      if (e.op === "move" || e.op === "trash") {
        const m = e as Movement;
        const { from, to } = keys.get(m.seq)!;
        if (m.op === "trash") trashes.add(m.seq);
        if (inTrash) continue;
        const rest = under(cur, from);
        if (rest === null) continue;
        if (m.op === "move") {
          step(e, "move", cur, to + rest, m);
          cur = to + rest;
        } else {
          inTrash = { seq: m.seq, path: to + rest };
          step(e, "trash", cur, inTrash.path, m);
        }
      } else if (e.op === "undo") {
        const of = (e as JournalUndo).of;
        const k = keys.get(of);
        if (!k) continue;
        if (trashes.has(of)) {
          if (inTrash?.seq !== of) continue;
          const rest = under(inTrash.path, k.to) ?? "";
          step(e, "undo", inTrash.path, k.from + rest);
          cur = k.from + rest;
          inTrash = undefined;
        } else if (!inTrash) {
          const rest = under(cur, k.to);
          if (rest === null) continue;
          step(e, "undo", cur, k.from + rest);
          cur = k.from + rest;
        }
      } else if (e.op === "purge" && inTrash && ((e as JournalNote).of as number[]).includes(inTrash.seq)) {
        step(e, "purge", inTrash.path, undefined);
        purged = true;
      }
    }
    return { steps, cur, inTrash, purged, placed: live.at(-1) };
  }

  /**
   * Settles operations a crashed process left half-recorded. A marker item whose destination
   * exists and source doesn't was done but not journaled; it gets journaled now, so undo knows
   * about it. Reads both marker formats: one op (`src`, `dst`, `entry`) and a group (`items`).
   * Markers younger than `minAgeMs` may belong to a live process and are left alone.
   */
  async recover(opts: { minAgeMs?: number } = {}): Promise<RecoverItem[]> {
    const minAge = opts.minAgeMs ?? 30_000;
    const result: RecoverItem[] = [];
    for (const name of await fs.readdir(this.inflightDir).catch(() => [] as string[])) {
      const file = path.join(this.inflightDir, name);
      let marker: { at: string; items?: InflightItem[] } & Partial<InflightItem>;
      let items: InflightItem[];
      try {
        marker = JSON.parse(await fs.readFile(file, "utf8"));
        items = Array.isArray(marker.items) ? marker.items : [{ src: marker.src!, dst: marker.dst!, entry: marker.entry! }];
        if (!items.every((it) => typeof it?.src === "string" && typeof it.dst === "string" && typeof it.entry?.op === "string")) throw new Error("bad marker");
      } catch {
        await fs.rm(file, { force: true });
        continue;
      }
      const show = (it: InflightItem) => ({ op: it.entry.op, from: this.relInside(it.src) ?? it.src, to: this.relInside(it.dst) ?? it.dst });
      if (Date.now() - (await fs.stat(file)).mtimeMs < minAge) {
        for (const it of items) result.push({ ...show(it), outcome: "in-progress" });
        continue;
      }
      const settled = await this.settle(items);
      const done = items.filter((_, i) => settled[i] === "done");
      if (done.length) await this.appendMany(done.map((it) => ({ ...it.entry, at: marker.at, recovered: true })));
      await fs.rm(file, { force: true });
      items.forEach((it, i) => result.push({ ...show(it), outcome: settled[i] === "done" ? "journaled" : settled[i] }));
    }
    return result;
  }
}

async function sizeOf(abs: string): Promise<number> {
  const st = await fs.stat(abs).catch(() => null);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of await fs.readdir(abs)) total += await sizeOf(path.join(abs, e));
  return total;
}

function hasExt(p: string): boolean {
  const base = path.basename(p);
  return base.lastIndexOf(".") > 0;
}

function record(m: Movement): MoveRecord {
  return { from: m.from, to: m.to, at: m.at, ...(m.batch ? { batch: m.batch } : {}), ...(m.op === "trash" ? { trashed: true as const } : {}), ...(m.by ? { by: m.by } : {}) };
}

export async function openVault(root: string, opts?: VaultOptions): Promise<Vault> {
  return Vault.open(root, opts);
}
