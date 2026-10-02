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
export { parsePolicy, type Policy, type LoadedPolicy } from "./policy.js";

const STORE_DIR = ".wasnew";
const IGNORE_FILE = ".wasnewignore";
const TMP_PREFIX = ".wasnew-tmp-";
const DEFAULT_IGNORE = [STORE_DIR, ".git", "node_modules", ".DS_Store", "Thumbs.db", "desktop.ini"];
/** gc leaves young blobs alone — a snapshot running concurrently may have written them before its manifest */
const GC_GRACE_MS = 10 * 60_000;
const RACY_MS = 2000;

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
interface JournalMove { seq: number; op: "move"; from: string; to: string; at: string; batch?: string; by?: Actor }
/** `to` is relative to the store: trash/<id>/<path> */
interface JournalTrash { seq: number; op: "trash"; from: string; to: string; at: string; batch?: string; by?: Actor }
interface JournalUndo { seq: number; op: "undo"; of: number; at: string; by?: Actor }
interface JournalRestore { seq: number; op: "restore"; snapshot: string; paths: string[]; at: string; guard?: string; by?: Actor }
interface JournalNote { seq: number; op: string; at: string; [key: string]: unknown }
export type JournalEntry = JournalMove | JournalTrash | JournalUndo | JournalRestore | JournalNote;
type Movement = JournalMove | JournalTrash;
const RESERVED_OPS = new Set(["move", "trash", "undo", "restore", "purge", "plan", "approve", "apply"]);

export interface MoveRecord { from: string; to: string; at: string; batch?: string; trashed?: true; by?: Actor }
export interface UndoSkip extends MoveRecord { reason: string; message: string }
export interface UndoResult { undone: MoveRecord[]; skipped: UndoSkip[] }
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
export interface ApplyResult { plan: string; batch: string; done: number; failed?: { index: number; code: string; message: string } }
export interface HistoryEvent { seq: number; op: string; at: string; from?: string; to?: string; batch?: string; by?: Actor; undone?: boolean }
export interface RecoverItem { op: string; from: string; to: string; outcome: "journaled" | "not-started" | "both-exist" | "missing" | "in-progress" }
export interface TrashPurge { dryRun: boolean; entries: { from: string; to: string; at: string }[]; bytes: number }
export interface VaultOptions {
  /** extra file or folder names never captured (on top of .git, node_modules, OS litter) */
  ignore?: string[];
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

  private async *walk(dir: string, rules: ReturnType<typeof parseIgnore>): AsyncGenerator<string> {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (this.ignoreNames.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = toPosix(path.relative(this.root, abs));
      if (e.isDirectory()) {
        if (!ignoredBy(rules, rel, true)) yield* this.walk(abs, rules);
      } else if (e.isFile() && !ignoredBy(rules, rel)) {
        yield abs;
      }
    }
  }

  /**
   * Stores a file's content as a blob. Hashes first and copies only if the blob is new.
   * The file can change between the two reads, so the hash of what was actually copied wins.
   */
  private async storeFile(abs: string): Promise<{ hash: string; size: number; isNew: boolean }> {
    const first = await hashFile(abs);
    if (await exists(this.objPath(first.hash))) return { ...first, isNew: false };
    await fs.mkdir(this.tmpDir, { recursive: true });
    const tmp = path.join(this.tmpDir, randomBytes(8).toString("hex"));
    const h = createHash("sha256");
    let size = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, done) { h.update(chunk); size += chunk.length; done(null, chunk); },
    });
    try {
      await pipeline(createReadStream(abs), tap, createWriteStream(tmp));
      const hash = h.digest("hex");
      const dest = this.objPath(hash);
      if (await exists(dest)) {
        await fs.rm(tmp, { force: true });
        return { hash, size, isNew: false };
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(tmp, dest);
      return { hash, size, isNew: true };
    } catch (e) {
      await fs.rm(tmp, { force: true });
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

  private async capture(rels: string[], label: string | undefined, partial: boolean, opts: { cache?: StatCache; skipIfUnchanged?: boolean } = {}): Promise<SnapshotResult> {
    const files: SnapshotFile[] = [];
    const stats = new Map<string, { size: number; mtimeMs: number }>();
    let newBlobs = 0, hashed = 0;
    for (const rel of rels) {
      const abs = this.resolveInside(rel);
      const st = await fs.stat(abs);
      stats.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
      const known = opts.cache?.files[rel];
      if (known && known[0] === st.size && known[1] === st.mtimeMs && (await exists(this.objPath(known[2])))) {
        files.push({ path: rel, hash: known[2], size: st.size });
        continue;
      }
      const stored = await this.storeFile(abs);
      hashed++;
      files.push({ path: rel, hash: stored.hash, size: stored.size });
      if (stored.isNew) newBlobs++;
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
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
      const tmp = this.statCachePath + "." + randomBytes(4).toString("hex");
      await fs.writeFile(tmp, JSON.stringify(cache), "utf8");
      await fs.rename(tmp, this.statCachePath);
    }
    return { id: snap.id, label, created, fileCount: files.length, newBlobs, hashed, ...(partial ? { partial: true } : {}) };
  }

  /**
   * Snapshot of everything under the root (minus ignores). Blobs already stored are not written
   * again, and files unchanged since the last snapshot are not even re-read (`rehash` forces it).
   * `skipIfUnchanged` returns the last snapshot instead of making an identical one.
   */
  async snapshot(opts: { label?: string; include?: (relative: string, size: number) => boolean | Promise<boolean>; rehash?: boolean; skipIfUnchanged?: boolean } = {}): Promise<SnapshotResult> {
    const rels: string[] = [];
    for await (const abs of this.walk(this.root, await this.ignoreRules())) {
      const rel = toPosix(path.relative(this.root, abs));
      if (opts.include && !(await opts.include(rel, (await fs.stat(abs)).size))) continue;
      rels.push(rel);
    }
    const cache = await this.readStatCache();
    return this.capture(rels, opts.label, false, { cache: opts.rehash ? { snapshot: cache.snapshot, files: {} } : cache, skipIfUnchanged: opts.skipIfUnchanged });
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
      for await (const abs of this.walk(this.root, await this.ignoreRules())) {
        after.set(toPosix(path.relative(this.root, abs)), (await hashFile(abs)).hash);
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
  private async append(entry: { op: string; at: string; [key: string]: unknown }): Promise<number> {
    return withLock(this.lockPath, async () => {
      const seq = await this.nextSeq();
      const line = JSON.stringify({ seq, ...entry }) + "\n";
      await fs.appendFile(this.journalPath, line, "utf8");
      this.seenBytes += Buffer.byteLength(line);
      this.lastSeq = seq;
      if ((entry.op === "move" || entry.op === "trash") && typeof entry.batch === "string") this.countOp(entry.batch);
      return seq;
    });
  }

  /** Records an app-defined event (e.g. "open") in the journal. Operation names wasnew writes itself are reserved. */
  async note(op: string, data: Record<string, unknown> = {}): Promise<number> {
    if (RESERVED_OPS.has(op)) throw new WasnewError("RESERVED_OP", "reserved journal op: " + op);
    return this.append({ ...data, op, at: new Date().toISOString() });
  }

  /**
   * Marks an operation as in flight until it is journaled. If the process dies between doing it
   * and writing it down, the marker stays and `recover()` settles it from what is on disk.
   */
  private async inflight(marker: { src: string; dst: string; entry: Record<string, unknown> }, fn: () => Promise<void>): Promise<void> {
    await fs.mkdir(this.inflightDir, { recursive: true });
    const file = path.join(this.inflightDir, `${Date.now()}-${process.pid}-${randomBytes(3).toString("hex")}.json`);
    await fs.writeFile(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...marker }));
    try {
      await fn();
    } catch (e) {
      // moved but not written down (e.g. the journal lock timed out): keep the marker for recover()
      const movedUnrecorded = (await exists(marker.dst)) && !(await exists(marker.src));
      if (!movedUnrecorded) await fs.rm(file, { force: true });
      throw e;
    }
    await fs.rm(file, { force: true });
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
        if ((e.op === "move" || e.op === "trash") && typeof b === "string") counts.set(b, (counts.get(b) ?? 0) + 1);
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

  private async guard(op: "move" | "trash", fromAbs: string, toAbs: string | null, batch?: string): Promise<void> {
    const p = await this.policy();
    await this.assertUnprotected(p, fromAbs);
    if (toAbs) await this.assertUnprotected(p, toAbs);
    if (op === "trash" && p.policy.allowTrash === false) throw new WasnewError("POLICY_DENIED", "trash is turned off by policy");
    const max = p.policy.maxOpsPerBatch;
    if (batch !== undefined && max !== undefined && (await this.opsInBatch(batch)) >= max) {
      throw new WasnewError("POLICY_LIMIT", `batch ${batch} reached the policy limit of ${max} operations`);
    }
  }

  // ── move · trash · undo ─────────────────────────────────

  /**
   * Moves and records. Refuses if the destination exists (no overwrite).
   * Everything that moves files must go through here for undo to be complete.
   * Pass `batch` to group moves for `undo({ batch })`, and `by` to say who and why.
   */
  async move(fromRel: string, toRel: string, batch?: string, by?: Actor): Promise<void> {
    const fromAbs = this.resolveSource(fromRel);   // the source may be outside the root
    const toAbs = this.resolveInside(toRel);       // the destination never is
    // `Report.PDF` → `Report.pdf` looks like "already exists" on Windows/macOS but is the same file — let the rename through
    const caseOnly = fromAbs !== toAbs && fromAbs.toLowerCase() === toAbs.toLowerCase();
    if (!caseOnly && (await exists(toAbs))) {
      throw new WasnewError("DEST_EXISTS", "destination already exists: " + toRel, toRel);
    }
    await this.guard("move", fromAbs, toAbs, batch);
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    const entry = { op: "move", from: toPosix(fromRel), to: toPosix(toRel), ...(batch ? { batch } : {}), ...(by ? { by } : {}) };
    await this.inflight({ src: fromAbs, dst: toAbs, entry }, async () => {
      await this.rename(fromAbs, toAbs);
      await this.append({ ...entry, at: new Date().toISOString() });
    });
  }

  /**
   * The delete verb for agents — sets a file or folder aside in `.wasnew/trash` instead of
   * removing it. `undo` puts it back; only a person's `emptyTrash` really deletes.
   * Returns where it went, relative to the store.
   */
  async trash(rel: string, batch?: string, by?: Actor): Promise<string> {
    const fromAbs = this.resolveInside(rel);
    if (fromAbs === this.root) throw new WasnewError("POLICY_DENIED", "cannot trash the whole folder");
    if (!(await exists(fromAbs))) throw new WasnewError("NOT_FOUND", "no such file: " + rel, rel);
    await this.guard("trash", fromAbs, null, batch);
    const from = toPosix(path.relative(this.root, fromAbs));
    const to = `trash/${snapshotId(new Date().toISOString())}/${from}`;
    const toAbs = path.join(this.store, to);
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    const entry = { op: "trash", from, to, ...(batch ? { batch } : {}), ...(by ? { by } : {}) };
    await this.inflight({ src: fromAbs, dst: toAbs, entry }, async () => {
      await this.rename(fromAbs, toAbs);
      await this.append({ ...entry, at: new Date().toISOString() });
    });
    return to;
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
    for (const m of targets) {
      const skip = (reason: string, message: string) => skipped.push({ ...record(m), reason, message });
      let toAbs: string, fromAbs: string;
      try {
        toAbs = m.op === "trash" ? this.trashPath(m.to) : this.resolveInside(m.to);
        fromAbs = m.op === "trash" ? this.resolveInside(m.from) : this.resolveSource(m.from);   // what came from a source goes back to it
      } catch (e: any) {
        skip(e?.code ?? "INVALID", String(e?.message ?? e));
        continue;
      }
      const caseOnly = fromAbs !== toAbs && fromAbs.toLowerCase() === toAbs.toLowerCase();   // a case-only rename: the original place is the file itself
      if (!caseOnly && (await exists(fromAbs))) {
        skip("ORIGIN_OCCUPIED", "something now exists at the original place: " + m.from);
        continue;
      }
      if (!(await exists(toAbs))) {
        skip("MISSING", "the moved file is no longer there: " + m.to);
        continue;
      }
      try {
        await fs.mkdir(path.dirname(fromAbs), { recursive: true });
        const entry = { op: "undo", of: m.seq, ...(opts.by ? { by: opts.by } : {}) };
        await this.inflight({ src: toAbs, dst: fromAbs, entry }, async () => {
          await this.rename(toAbs, fromAbs);
          await this.append({ ...entry, at: new Date().toISOString() });
        });
      } catch (e: any) {
        skip(e?.code ?? "ERROR", String(e?.message ?? e));
        continue;
      }
      undone.push(record(m));
      // folders the move created go away once empty
      await this.pruneEmptyDirs(path.dirname(toAbs), m.op === "trash" ? this.trashDir : this.root);
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

  /** Removes now-empty folders up toward `stopAt` — best effort; only empty folders can go */
  private async pruneEmptyDirs(dirAbs: string, stopAt = this.root): Promise<void> {
    let cur = dirAbs;
    while (cur !== stopAt && cur.startsWith(stopAt + path.sep)) {
      try {
        if ((await fs.readdir(cur)).length > 0) return;
        await fs.rmdir(cur);
      } catch { return; }
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
    const limit = (await this.policy()).policy.requireApprovalOver;
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
    const limit = (await this.policy()).policy.requireApprovalOver;
    if (limit !== undefined && plan.ops.length > limit && !plan.approved) {
      throw new WasnewError("NEEDS_APPROVAL", `plan ${id} has ${plan.ops.length} operations; policy wants a person to approve more than ${limit} (wasnew approve ${id})`);
    }
    const fresh = await this.check(plan.ops);
    if (fresh.length) throw new WasnewError("PLAN_INVALID", `the folder changed since the plan: ${fresh[0].code} at operation ${fresh[0].index}`);
    const batch = opts.batch ?? "plan-" + id;
    const by = opts.by ?? plan.by;
    let done = 0;
    let failed: ApplyResult["failed"];
    for (let index = 0; index < plan.ops.length; index++) {
      const op = plan.ops[index];
      try {
        if (op.op === "move") await this.move(op.from, op.to, batch, by);
        else await this.trash(op.path, batch, by);
        done++;
      } catch (e: any) {
        failed = { index, code: e?.code ?? "ERROR", message: String(e?.message ?? e) };
        break;
      }
    }
    plan.applied = { at: new Date().toISOString(), batch };
    await fs.writeFile(this.planPath(id), JSON.stringify(plan, null, 1), "utf8");
    await this.append({ op: "apply", plan: id, batch, done, at: plan.applied.at, ...(by ? { by } : {}) });
    return { plan: id, batch, done, ...(failed ? { failed } : {}) };
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

  /**
   * Settles operations a crashed process left half-recorded. A marker whose destination exists
   * and source doesn't was done but not journaled — it gets journaled now, so undo knows about it.
   * Markers younger than `minAgeMs` may belong to a live process and are left alone.
   */
  async recover(opts: { minAgeMs?: number } = {}): Promise<RecoverItem[]> {
    const minAge = opts.minAgeMs ?? 30_000;
    const items: RecoverItem[] = [];
    for (const name of await fs.readdir(this.inflightDir).catch(() => [] as string[])) {
      const file = path.join(this.inflightDir, name);
      let marker: { at: string; src: string; dst: string; entry: Record<string, unknown> & { op: string } };
      try {
        marker = JSON.parse(await fs.readFile(file, "utf8"));
      } catch {
        await fs.rm(file, { force: true });
        continue;
      }
      const show = { op: marker.entry.op, from: this.relInside(marker.src) ?? marker.src, to: this.relInside(marker.dst) ?? marker.dst };
      if (Date.now() - (await fs.stat(file)).mtimeMs < minAge) {
        items.push({ ...show, outcome: "in-progress" });
        continue;
      }
      const [src, dst] = [await exists(marker.src), await exists(marker.dst)];
      let outcome: RecoverItem["outcome"];
      if (dst && !src) {
        await this.append({ ...marker.entry, at: marker.at, recovered: true });
        outcome = "journaled";
      } else if (src && !dst) {
        outcome = "not-started";
      } else {
        outcome = src ? "both-exist" : "missing";
      }
      await fs.rm(file, { force: true });
      items.push({ ...show, outcome });
    }
    return items;
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

function record(m: Movement): MoveRecord {
  return { from: m.from, to: m.to, at: m.at, ...(m.batch ? { batch: m.batch } : {}), ...(m.op === "trash" ? { trashed: true as const } : {}), ...(m.by ? { by: m.by } : {}) };
}

export async function openVault(root: string, opts?: VaultOptions): Promise<Vault> {
  return Vault.open(root, opts);
}
