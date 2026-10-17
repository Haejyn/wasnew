# Using wasnew with Claude Code

English | [한국어](README.ko.md)

Claude Code checkpoints only undo edits made by its file tools. This example covers shell `rm` and `mv` and folders outside git.

## 1. Add the MCP server

```bash
claude mcp add --transport stdio wasnew -- node /path/to/wasnew/bin/wasnew.js mcp --root ~/Downloads
```

## 2. Three hooks (`settings.json`)

| Hook | What it does |
|---|---|
| `UserPromptSubmit` | Snapshots `$WASNEW_ROOT` on every prompt. `--if-changed` skips it when nothing changed, and unchanged files are not read again. |
| `PreToolUse`, matcher `Bash\|PowerShell` | [`guard.mjs`](guard.mjs) blocks `rm`, `mv`, `del`, `Remove-Item`, `git rm`, `git mv`, `git clean`, `git reset --hard`, `find -delete` and similar, and tells the agent to use `wasnew_trash` or `wasnew_move` instead. |
| `PreToolUse`, matcher `Read\|Edit\|MultiEdit` | [`moved.mjs`](moved.mjs) checks a file that no longer exists against the journal. If it moved, the call is blocked and the agent gets the new path. If it is in the trash, the agent gets the batch to undo. If the file exists or the journal has no record, the call goes through. |

Replace `/path/to/wasnew` in [`settings.json`](settings.json) and merge it into `~/.claude/settings.json` or a project's `.claude/settings.json`. Set `WASNEW_ROOT` to the folder to protect.
On Windows, hook commands run in PowerShell and `$WASNEW_ROOT` is not expanded. Write the folder path in the command directly.

## 3. Require approval for large changes

`<folder>/.wasnew/policy.json`:

```json
{ "protect": ["Taxes/", "*.key"], "requireApprovalOver": 20, "maxOpsPerBatch": 1000 }
```

With this policy, more than 20 moves or trashes in one call are refused, and the agent can only propose them with `wasnew_plan`. Review and approve in a terminal:

```bash
wasnew plans
wasnew show <id>
wasnew approve <id>
```

Then the agent runs it with `wasnew_apply`. The MCP server has no approve tool, so the agent cannot approve its own plan.

## Limits

- `guard.mjs` matches the command text. It does not catch deletes inside a script file or in another language. Keep the snapshot hook, and for closer coverage run `wasnew watch --root <folder>` separately.
- wasnew tools cannot edit the policy file, but nothing stops the agent from editing it with another tool.
