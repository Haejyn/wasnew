/**
 * Pattern summaries of many moves and trashes, so a 5,000-item result costs a few lines of an
 * agent's context instead of 5,000 entries. Pure: no disk access, same input gives the same lines.
 */
export interface SummaryOp {
  op?: "move" | "trash" | "undo";
  from: string;
  /** move and undo: where it went. An undo of a trash goes from the trash back to `to`. */
  to?: string;
  /** undo: what came back was in the trash (`from` is then store-relative) */
  trashed?: boolean;
}
export interface OpSummary { lines: string[]; total: number; groups: { count: number; pattern: string }[] }

const TRASH = "\0trash";   // a dir no real path has
type Shape = "move" | "rename" | "move+rename";
interface Item { kind: "move" | "trash" | "undo"; shape: Shape; fromDir: string; toDir: string; ext: string; fromBase: string; toBase: string }
interface Group { key: string; items: Item[]; fromDir: string; toDir: string; ext: string | null }

const norm = (p: string) => p.replaceAll("\\", "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
const dirOf = (p: string) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const extOf = (base: string) => { const i = base.lastIndexOf("."); return i > 0 ? base.slice(i + 1).toLowerCase() : ""; };
const count = (n: number) => n.toLocaleString("en-US");
const showDir = (d: string) => (d === TRASH ? "trash" : d === "" ? "./" : d + "/");
const depthOf = (d: string) => (d === TRASH || d === "" ? 0 : d.split("/").length);

/** Keeps the first `depth` segments; anything deeper becomes `*` */
function cut(dir: string, depth: number): string {
  if (dir === TRASH || dir === "") return dir;
  const segs = dir.split("/");
  return segs.length <= depth ? dir : segs.slice(0, depth).join("/") + "/*";
}

function toItem(o: SummaryOp): Item {
  const kind = o.op ?? (o.to === undefined ? "trash" : "move");
  const from = norm(o.from);
  if (kind === "trash" || o.to === undefined) {
    const base = baseOf(from);
    return { kind: "trash", shape: "move", fromDir: dirOf(from), toDir: TRASH, ext: extOf(base), fromBase: base, toBase: base };
  }
  const to = norm(o.to);
  const fromDir = kind === "undo" && o.trashed ? TRASH : dirOf(from);
  const fromBase = baseOf(from), toBase = baseOf(to);
  const toDir = dirOf(to);
  const shape: Shape = fromBase === toBase ? "move" : fromDir === toDir ? "rename" : "move+rename";
  return { kind, shape, fromDir, toDir, ext: extOf(fromBase), fromBase, toBase };
}

function commonPrefix(xs: string[]): string {
  let p = xs[0];
  for (const x of xs) while (!x.startsWith(p)) p = p.slice(0, -1);
  return p;
}
function commonSuffix(xs: string[], skip: number): string {
  let s = xs[0].slice(skip);
  for (const x of xs) while (!x.slice(skip).endsWith(s)) s = s.slice(1);
  return s;
}
/** `IMG_*.jpg` when the names share a prefix or more than the extension at the end, else null */
function namePattern(names: string[], ext: string): string | null {
  const prefix = commonPrefix(names).replace(/\d+$/, "");   // IMG_0* reads worse than IMG_*
  const suffix = commonSuffix(names, prefix.length).replace(/^\d+/, "");
  if (!prefix && suffix.length <= (ext ? ext.length + 1 : 0)) return null;
  return prefix + "*" + suffix;
}

function render(g: Group): string {
  const n = g.items.length;
  const first = g.items[0];
  const undone = first.kind === "undo" ? " (undone)" : "";
  if (first.shape === "rename") {
    let detail = "";
    if (n === 1) detail = ` (${first.fromBase} → ${first.toBase})`;
    else if (g.ext !== null) {
      const a = namePattern(g.items.map((i) => i.fromBase), g.ext);
      const b = namePattern(g.items.map((i) => i.toBase), extOf(first.toBase));
      if (a && b) detail = ` (${a} → ${b})`;
    }
    return `${count(n)} renamed in ${showDir(g.fromDir)}${detail}${undone}`;
  }
  const what = n === 1 ? first.fromBase : g.ext ? `*.${g.ext}` : "*";
  return `${count(n)} × ${what}  ${showDir(g.fromDir)} → ${showDir(g.toDir)}${first.shape === "move+rename" ? " (renamed)" : ""}${undone}`;
}

function groupAt(items: Item[], keepExt: boolean, depth: number): Group[] {
  const groups = new Map<string, Group>();
  for (const it of items) {
    const fromDir = cut(it.fromDir, depth), toDir = cut(it.toDir, depth);
    const ext = keepExt ? it.ext : null;
    const key = [it.kind, it.shape, fromDir, toDir, ext ?? "\0"].join("\n");
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, items: [], fromDir, toDir, ext }));
    g.items.push(it);
  }
  // merged across extensions, a group that still has only one keeps showing it
  if (!keepExt) for (const g of groups.values()) if (g.items.every((i) => i.ext === g.items[0].ext)) g.ext = g.items[0].ext;
  return [...groups.values()];
}

/**
 * Groups ops by (from folder, to folder, extension, name kept or changed) and renders one line per
 * group, biggest first. Over `maxLines` (default 12) groups, merges further: first across
 * extensions, then by cutting folders to fewer segments (`sorted/*`), and finally ends with
 * `… N more groups`.
 */
export function summarizeOps(ops: SummaryOp[], opts: { maxLines?: number } = {}): OpSummary {
  const maxLines = Math.max(2, opts.maxLines ?? 12);
  const items = ops.map(toItem);
  const maxDepth = Math.max(0, ...items.map((i) => Math.max(depthOf(i.fromDir), depthOf(i.toDir))));
  let groups = groupAt(items, true, Infinity);
  if (groups.length > maxLines) groups = groupAt(items, false, Infinity);
  for (let d = maxDepth - 1; groups.length > maxLines && d >= 1; d--) groups = groupAt(items, false, d);
  const rendered = groups.map((g) => ({ count: g.items.length, line: render(g) }))
    .sort((a, b) => b.count - a.count || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
  const shown = rendered.length > maxLines ? rendered.slice(0, maxLines - 1) : rendered;
  const lines = shown.map((r) => r.line);
  if (shown.length < rendered.length) lines.push(`… ${count(rendered.length - shown.length)} more groups`);
  return {
    lines,
    total: ops.length,
    groups: rendered.map((r) => ({ count: r.count, pattern: r.line.replace(/^[\d,]+ (× )?/, "") })),
  };
}
