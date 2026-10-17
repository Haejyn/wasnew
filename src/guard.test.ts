import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openVault } from "./index.js";

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "claude-code", "guard.mjs");
const run = (command: string) => spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), encoding: "utf8" });

describe("Claude Code guard hook", () => {
  it.each([
    "rm -rf ~/Downloads/old",
    "cd docs && rm a.txt",
    "mv a.txt b.txt",
    "find . -name '*.tmp' -delete",
    "git reset --hard HEAD~1",
    "git clean -fd",
    "Remove-Item -Recurse C:\\Users\\me\\Desktop\\x",
    "del /q old.txt",
    "sudo rm -f /etc/x",
    "ls | xargs -0 rm",
    "git mv a b",
  ])("blocks %s and says what to use instead", (command) => {
    const r = run(command);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Use wasnew_/);
  });

  it.each(["ls -la", "git status", "npm run move-files", "cat remove.txt", "grep -rn rmdir src"])("lets %s through", (command) => {
    expect(run(command).status).toBe(0);
  });

  it("ignores input it cannot read", () => {
    expect(spawnSync(process.execPath, [GUARD], { input: "not json", encoding: "utf8" }).status).toBe(0);
  });
});

const MOVED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "claude-code", "moved.mjs");
const open = (tool: string, file: string) =>
  spawnSync(process.execPath, [MOVED], { input: JSON.stringify({ tool_name: tool, tool_input: { file_path: file } }), encoding: "utf8" });

describe("Claude Code moved-file hook", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "wasnew-hook-"));
    await fs.mkdir(path.join(root, "docs"));
    await fs.writeFile(path.join(root, "a.pdf"), "a");
    await fs.writeFile(path.join(root, "docs", "b.md"), "b");
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it("blocks a Read, Edit or Write of a moved file and gives the new path", async () => {
    const v = await openVault(root);
    await v.move("a.pdf", "Papers/2026/a.pdf", "t1", { agent: "claude-code" });
    await v.move("docs", "notes", "t1");
    for (const tool of ["Read", "Edit", "Write"]) {
      const r = open(tool, path.join(root, "a.pdf"));
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("a.pdf was moved to Papers/2026/a.pdf (by claude-code at ");
      expect(r.stderr).toContain(`Use ${path.join(root, "Papers", "2026", "a.pdf")} instead.`);
    }
    expect(open("Read", path.join(root, "docs", "b.md")).stderr).toContain("moved to notes/b.md");
  });

  it("never blocks a file that exists, a path the journal does not know, or a move that was undone", async () => {
    const v = await openVault(root);
    expect(open("Read", path.join(root, "a.pdf")).status).toBe(0);
    expect(open("Read", path.join(root, "never.txt")).status).toBe(0);
    await v.move("a.pdf", "x/a.pdf", "t1");
    await v.undo({ batch: "t1" });
    await fs.rm(path.join(root, "a.pdf"));
    expect(open("Read", path.join(root, "a.pdf")).status).toBe(0);
    expect(open("Read", path.join(os.tmpdir(), "no-wasnew-here", "x.txt")).status).toBe(0);
    expect(spawnSync(process.execPath, [MOVED], { input: "not json", encoding: "utf8" }).status).toBe(0);
  });

  it("points a Read of a trashed file at undo, lets a Write create a new one", async () => {
    const v = await openVault(root);
    await v.trash("a.pdf", "t9");
    const r = open("Read", path.join(root, "a.pdf"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("a.pdf is in wasnew's trash (trashed at ");
    expect(r.stderr).toContain("batch t9");
    expect(open("Write", path.join(root, "a.pdf")).status).toBe(0);
  });
});
