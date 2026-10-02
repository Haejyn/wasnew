import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
