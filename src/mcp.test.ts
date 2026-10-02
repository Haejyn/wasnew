import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { PassThrough } from "node:stream";
import path from "node:path";
import os from "node:os";
import { serveMcp } from "./mcp.js";
import { openVault } from "./index.js";

let base: string, root: string;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "wasnew-mcp-"));
  root = path.join(base, "root");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "a.txt"), "hello\n");
  await fs.writeFile(path.join(root, "b.txt"), "bee\n");
  await fs.writeFile(path.join(base, "secret.txt"), "outside\n");
});
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

/** Real newline-delimited JSON-RPC over streams, as a client would speak it */
async function session(messages: object[], opts: { allowOutsideSources?: boolean } = {}) {
  const input = new PassThrough(), output = new PassThrough();
  let raw = "";
  output.on("data", (c) => { raw += c; });
  const done = serveMcp({ root, input, output, ...opts });
  for (const m of messages) input.write(JSON.stringify(m) + "\n");
  input.end();
  await done;
  return raw.trim().split("\n").map((l) => JSON.parse(l));
}
const call = (id: number, name: string, args: object = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

describe("mcp server", () => {
  it("handshakes, lists tools and ignores notifications", async () => {
    const [init, list, ...rest] = await session([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "nope" },
    ]);
    expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", serverInfo: { name: "wasnew" }, capabilities: { tools: {} } });
    expect(list.result.tools.map((t: any) => t.name)).toEqual(["wasnew_snapshot", "wasnew_log", "wasnew_diff", "wasnew_move", "wasnew_trash", "wasnew_plan", "wasnew_apply", "wasnew_history", "wasnew_pending", "wasnew_undo", "wasnew_restore", "wasnew_read"]);
    expect(list.result.tools.every((t: any) => t.inputSchema.type === "object" && !("run" in t))).toBe(true);
    expect(rest).toEqual([{ jsonrpc: "2.0", id: 3, error: { code: -32601, message: "method not found: nope" } }]);
  });

  it("an agent's task: snapshot, move as a batch, explain, undo", async () => {
    const r = await session([
      call(1, "wasnew_snapshot", { label: "before sorting" }),
      call(2, "wasnew_move", { moves: [{ from: "a.txt", to: "sorted/a.txt" }, { from: "b.txt", to: "sorted/b.txt" }, { from: "nope.txt", to: "x.txt" }], batch: "task-1" }),
      call(3, "wasnew_pending", { batch: "task-1" }),
      call(4, "wasnew_undo", { batch: "task-1" }),
    ]);
    const snap = r[0].result.structuredContent;
    expect(snap.fileCount).toBe(2);
    expect(r[1].result.structuredContent).toMatchObject({ batch: "task-1", moved: 2, failed: [{ from: "nope.txt", code: "ENOENT" }] });
    expect(r[2].result.structuredContent.total).toBe(2);
    expect(r[3].result.structuredContent.undone).toHaveLength(2);
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("hello\n");
  });

  it("diff reads like a changelog; restore is guarded; read shows the old content", async () => {
    const [snap] = await session([call(1, "wasnew_snapshot")]);
    const id = snap.result.structuredContent.id;
    await fs.writeFile(path.join(root, "a.txt"), "edited\n");
    const [diff, restore, read] = await session([
      call(1, "wasnew_diff", { from: id }),
      call(2, "wasnew_restore", { snapshot: id }),
      call(3, "wasnew_read", { snapshot: id, path: "a.txt" }),
    ]);
    expect(diff.result.content[0].text).toBe("0 added, 1 changed, 0 missing, 0 moved\n~ a.txt");
    expect(restore.result.structuredContent.guard).toBeTruthy();
    expect(read.result.content[0].text).toBe("hello\n");
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("hello\n");
  });

  it("tool errors come back as readable results with a code", async () => {
    const [dest, outside, badId] = await session([
      call(1, "wasnew_move", { moves: [{ from: "a.txt", to: "b.txt" }] }),
      call(2, "wasnew_move", { moves: [{ from: "../secret.txt", to: "stolen.txt" }] }),
      call(3, "wasnew_read", { snapshot: "../../x", path: "a.txt" }),
    ]);
    expect(dest.result.structuredContent.failed[0].code).toBe("DEST_EXISTS");
    expect(outside.result.structuredContent.failed[0].code).toBe("OUTSIDE_ROOT");
    expect(badId.result).toMatchObject({ isError: true, structuredContent: { error: { code: "BAD_SNAPSHOT_ID" } } });
    expect(await fs.readFile(path.join(base, "secret.txt"), "utf8")).toBe("outside\n");
  });

  it("can opt in to collecting files from outside the folder", async () => {
    const [r] = await session([call(1, "wasnew_move", { moves: [{ from: path.join(base, "secret.txt"), to: "in/secret.txt" }] })], { allowOutsideSources: true });
    expect(r.result.structuredContent.moved).toBe(1);
  });

  it("records the connected client as the agent, with the model's reason", async () => {
    const r = await session([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.0" } } },
      call(2, "wasnew_move", { moves: [{ from: "a.txt", to: "notes/a.txt" }], batch: "t", reason: "group notes", model: "m-1" }),
      call(3, "wasnew_trash", { paths: ["b.txt"], batch: "t", reason: "duplicate" }),
      call(4, "wasnew_history", { path: "a.txt" }),
    ]);
    expect(r[2].result.structuredContent.trashed).toBe(1);
    expect(r[3].result.structuredContent.events[0].by).toEqual({ agent: "claude-code 2.1.0", model: "m-1", reason: "group notes" });
    await expect(fs.access(path.join(root, "b.txt"))).rejects.toThrow();
    const [undo] = await session([call(1, "wasnew_undo", { batch: "t" })]);
    expect(undo.result.structuredContent.undone).toHaveLength(2);
    expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("bee\n");
  });

  it("past the approval limit the agent must plan, and only a person can approve", async () => {
    await fs.mkdir(path.join(root, ".wasnew"), { recursive: true });
    await fs.writeFile(path.join(root, ".wasnew", "policy.json"), JSON.stringify({ requireApprovalOver: 1 }));
    const moves = [{ from: "a.txt", to: "x/a.txt" }, { from: "b.txt", to: "x/b.txt" }];
    const [direct, list, planned] = await session([
      call(1, "wasnew_move", { moves }),
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      call(3, "wasnew_plan", { ops: moves.map((m) => ({ op: "move", ...m })), reason: "sort" }),
    ]);
    expect(direct.result).toMatchObject({ isError: true, structuredContent: { error: { code: "NEEDS_APPROVAL" } } });
    expect(list.result.tools.some((t: any) => /approve/.test(t.name))).toBe(false);
    const id = planned.result.structuredContent.id;
    expect(planned.result.content[0].text).toContain(`needs the user's approval (wasnew approve ${id})`);

    const [early] = await session([call(1, "wasnew_apply", { plan: id })]);
    expect(early.result.structuredContent.error.code).toBe("NEEDS_APPROVAL");
    await (await openVault(root)).approve(id, "person");
    const [applied] = await session([call(1, "wasnew_apply", { plan: id })]);
    expect(applied.result.structuredContent).toMatchObject({ done: 2 });
    expect(await fs.readFile(path.join(root, "x", "a.txt"), "utf8")).toBe("hello\n");
  });

  it("answers garbage with a parse error and keeps going", async () => {
    const input = new PassThrough(), output = new PassThrough();
    let raw = "";
    output.on("data", (c) => { raw += c; });
    const done = serveMcp({ root, input, output });
    input.write("{not json\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }) + "\n");
    input.end();
    await done;
    expect(raw.trim().split("\n").map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
      { jsonrpc: "2.0", id: 9, result: {} },
    ]);
  });
});
