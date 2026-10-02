#!/usr/bin/env node
// Claude Code PreToolUse hook: blocks shell commands that delete or move files and points
// the agent at the wasnew MCP tools instead. Exit code 2 blocks the call and shows stderr to the agent.
let input = "";
for await (const chunk of process.stdin) input += chunk;
let command = "";
try {
  command = JSON.parse(input)?.tool_input?.command ?? "";
} catch {
  process.exit(0);
}
// a word counts only in command position: at the start, after ; & | ( ` or a newline, or after sudo / xargs / exec / nohup
const AT = String.raw`(?:^|[;&|(\x60\n]\s*|\b(?:sudo|xargs|exec|nohup)\s+(?:-\S+\s+)*)`;
const rule = (body, flags = "i") => new RegExp(AT + body, flags);
const rules = [
  [rule(String.raw`(?:rm|rmdir|del|erase|rd|Remove-Item|shred|unlink)(?=\s|$)`), "deletes files", "wasnew_trash (undoable)"],
  [rule(String.raw`(?:mv|move|Move-Item|ren|rename)(?=\s|$)`), "moves files", "wasnew_move or wasnew_plan (undoable)"],
  [rule(String.raw`git\s+(?:mv|rm)(?=\s|$)`), "moves or deletes files", "wasnew_move or wasnew_trash (undoable)"],
  [rule(String.raw`git\s+(?:clean|reset\s+--hard|checkout\s+--\s)`), "discards changes", "wasnew_snapshot first, then ask the user"],
  [rule(String.raw`find\s.*\s-delete(?=\s|$)`), "deletes files", "wasnew_trash (undoable)"],
];
for (const [pattern, what, instead] of rules) {
  if (pattern.test(command)) {
    console.error(`Blocked: this command ${what} and could not be undone. Use ${instead} instead.`);
    process.exit(2);
  }
}
process.exit(0);
