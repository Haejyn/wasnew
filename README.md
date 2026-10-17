<p align="center"><img src="assets/icon-512.png" width="128" alt="wasnew"></p>

# wasnew

wasnew is an undo layer for AI agents' file operations: it journals every move, rename and delete an agent makes in any folder, and undoes them per task, with or without git.

![Terminal replay. Claude Code sorts a Downloads folder of 199 files with wasnew_plan and wasnew_apply. In a new session it tries to read invoice_oct.pdf at its old path, a hook blocks the read and gives the new path. Asked to run rm -rf Screenshots, another hook blocks the command and the agent uses wasnew_trash. Then wasnew undo puts all 199 files back.](assets/demo.gif)

A real Claude Code session, run headless and replayed from its log ([scripts/demo](scripts/demo/)). Also as [MP4](assets/demo.mp4).

[English](README.md) | [한국어](README.ko.md)

![tests](https://img.shields.io/badge/tests-130%20passed-16a34a)
![node](https://img.shields.io/badge/node-%E2%89%A520-339933)
![deps](https://img.shields.io/badge/dependencies-0-111111)
![mcp](https://img.shields.io/badge/MCP-16%20tools-111111)
![license](https://img.shields.io/badge/license-MIT-blue)

Agents sort Downloads folders, rename photo libraries and clean up project trees. The Claude Code docs state: "Checkpointing does not track files modified by Bash commands", and they give `rm`, `mv` and `cp` as examples ([source](https://code.claude.com/docs/en/checkpointing)). git covers committed files in a repository and nothing else.

wasnew gives the agent MCP tools to move and trash files instead. Each change is written to a journal in the folder with who did it and why, deletes go to a trash folder, and one command undoes a whole task.

> The icon is the new moon, the moment the moon was new. The hairline of light at the bottom becomes the crescent of [willnew](https://github.com/Haejyn/willnew).

## Quick start

wasnew is not on npm yet. Install from source (Node 20 or newer, pnpm):

```bash
git clone https://github.com/Haejyn/wasnew && cd wasnew
pnpm install && pnpm build
claude mcp add --transport stdio wasnew -- node "$PWD/bin/wasnew.js" mcp --root ~/Downloads
```

For Claude Desktop, add to `claude_desktop_config.json`:

```json
{ "mcpServers": { "wasnew": { "command": "node", "args": ["/path/to/wasnew/bin/wasnew.js", "mcp", "--root", "C:/Users/me/Downloads"] } } }
```

## An agent session

```text
user   sort my downloads into folders and get rid of the junk
agent  wasnew_snapshot  "before sorting"              → 201 files
agent  wasnew_plan      199 operations                → 0 issues, no approval needed
agent  wasnew_apply     plan f51626427972437c         → 177 moved into 12 folders, 22 trashed
user   wasnew undo --batch plan-f51626427972437c      → undone 199
```

## MCP tools

| Tool | What it does |
|---|---|
| `wasnew_snapshot` | Save the current content of every file. Call before changing many files |
| `wasnew_move` | Move or rename. An existing destination fails with `DEST_EXISTS`. One batch per task, `reason` says why |
| `wasnew_trash` | Delete by moving to the folder's trash. `wasnew_undo` brings it back |
| `wasnew_plan` | Check a list of moves and trashes without touching anything. Reports issues per operation and whether approval is needed |
| `wasnew_apply` | Run a plan exactly, once, as one batch. `NEEDS_APPROVAL` before approval, `PLAN_INVALID` if the folder changed since |
| `wasnew_undo` | Undo a whole batch, the last N of a batch, or the last N overall. What can't be undone is reported with a reason |
| `wasnew_restore` | Restore content from a snapshot. Files it overwrites are saved first in a `guard` snapshot |
| `wasnew_diff` | Added, changed, missing and moved files (moves found by content hash). For telling the user what a task did |
| `wasnew_history` | Moves, trashes, undos and restores of one file: when, by whom, why |
| `wasnew_where` | Where the file at an old path is now, following folder moves, trash and undo. Calls that fail on a missing path also get `movedTo` |
| `wasnew_read` | Read a file as it was in a snapshot |
| `wasnew_log` | List snapshots |
| `wasnew_pending` | Moves that can still be undone |
| `wasnew_redo` | Do again what was undone: a whole batch or the last N. Recorded as new operations, so `wasnew_undo` can take the redo back |
| `wasnew_lessons` | Kinds of moves and trashes the user undid (avoid) or kept many times (ok) in this folder |
| `wasnew_agents` | Each agent's operations, undos and undo rate in this folder |

- The MCP client name (`clientInfo`) is recorded as the agent; the model adds `model` and `reason`.
- There is no approve tool in MCP. An agent cannot approve its own plan.
- By default only files inside `--root` can be moved. `--allow-outside-sources` lets agents move files in from outside.
- Tool failures come back as `isError` results, not protocol errors, so the agent can read the code and retry.
- Large results return a few `summary` lines (`751 × *.jpg  Downloads/ → sorted/jpg/`) and the first 20 items, with `truncated: true`. Lists over 50 come back in full only with `full: true`. See [Token cost](#token-cost).
- To also block shell `rm` and `mv`, use the [Claude Code hook example](examples/claude-code/).

## Policy (`.wasnew/policy.json`)

```json
{ "protect": ["Taxes/", "*.key"], "requireApprovalOver": 20, "maxOpsPerBatch": 1000, "allowTrash": true }
```

| Key | Meaning |
|---|---|
| `protect` | gitignore syntax. Moving, trashing or moving onto these paths is refused, including folders that contain them |
| `requireApprovalOver` | More operations than this go through plan → `approve` by a person → apply |
| `maxOpsPerBatch` | Most operations in one batch (blast radius) |
| `allowTrash` | `false` turns off trashing too |
| `trust` | `{ "minOps": 50, "maxUndoRate": 0.05, "approvalOver": 200 }`. An agent with at least `minOps` operations and an undo rate at or below `maxUndoRate` gets `approvalOver` instead of `requireApprovalOver`. Never lower than the base, never for an agent recorded as unknown |

If the policy file is invalid, every operation fails with `POLICY_INVALID` until it is fixed.

## Plan → approve → apply

```text
agent  wasnew_plan   → plan baebff75: 3 operations, 0 issues, needs the user's approval (wasnew approve baebff75)
person wasnew show baebff75
person wasnew approve baebff75
agent  wasnew_apply  → done 3, batch plan-baebff75
person wasnew history "copy of notes.md"
       trash  copy of notes.md -> trash/…  by claude-code 2.1.0 (sort Downloads)
person wasnew undo --batch plan-baebff75
```

A plan is checked in order, each operation against the result of the ones before it. Sources already moved, destinations that collide within the plan, protected paths and limits are reported with the operation number.

## Lessons and trust

wasnew groups the journal's moves and trashes by kind (operation, file extension or folder, source folder, destination folder) and counts how many were undone. A kind undone at least twice and in at least half the cases becomes an avoid lesson. When an agent connects, up to 5 of them are added to the MCP instructions, and `wasnew_plan` returns `lessons` for operations in the plan that match one:

```text
Past undos in this folder:
- avoid: moving *.hwp from ./ to Docs/ was undone 3 of 3 times (claude-code 2.1.0), last reason "group documents by type"
- avoid: trashing folders in ./ was undone 2 of 2 times (claude-code 2.1.0), last reason "remove build output"
```

The same counts give each agent an undo rate (`wasnew agents`), which the `trust` policy key uses to raise the approval threshold. The agent name is the MCP client's `clientInfo`, set by the client program, not by the model. It includes the client's version, so a client update starts a new record. Trust saves approval prompts; it is not a security boundary, since any program that connects can send any name.

## Benchmarks

wasnew against git on the same jobs (`scripts/bench-git.mjs`). Median of 3 runs, milliseconds unless noted. Windows 11 on NTFS, Intel i5-12400F (12 threads), Node 24.14, git 2.53.0.windows.2, 2026-10-17. Other processes kept the CPU about 30% busy during the runs, so absolute times are noisy; compare within a row.

On the git side, reorganize is `fs.rename` then `git add -A && git commit`, undo is `git reset --hard HEAD~1`, and trash is `git rm` then `git reset --hard`. The third column runs git with compression off, which is fairer for incompressible data.

Media: 8 files × 256 MB of random (incompressible) data

| Step | wasnew | git | git (no compression) |
|---|---:|---:|---:|
| First snapshot | 4,348 | 71,588 | 23,543 |
| Re-snapshot, nothing changed | 2 | 44 | 43 |
| Reorganize (move every file into subfolders) | 11 | 11,458 | 11,732 |
| Undo reorganize | 12 | 8,667 | 8,714 |
| Trash 10% + undo | 9 | 2,328 | 2,351 |
| Store size | 2,048.0 MB | 2,048.7 MB | 2,048.3 MB |

Small: 5,000 files × 4 KB

| Step | wasnew | git | git (no compression) |
|---|---:|---:|---:|
| First snapshot | 2,336 | 7,034 | 7,880 |
| Re-snapshot, nothing changed | 151 | 57 | 53 |
| Reorganize | 2,646 | 3,699 | 3,797 |
| Undo reorganize | 2,572 | 2,566 | 2,647 |
| Trash 10% + undo | 555 | 659 | 630 |
| Store size | 21.9 MB | 20.3 MB | 20.5 MB |

With large files wasnew wins because its moves and undos are renames, while git rewrites the working tree and rehashes content. It loses the unchanged re-snapshot on small files because it stats each file from Node, while git relies on its cached directory scan on Windows. Undo on small files is about even (2,572 vs 2,566 ms).

```bash
pnpm build && pnpm bench:git
```

`pnpm bench` times wasnew alone on a larger tree. Its last recorded run (Linux, Intel Xeon 2.1 GHz 4 cores, Node 22.22, 2026-10-02): snapshot of 2,626 files including one 1 GiB file in 5.4 s with 162 MB peak RSS, unchanged re-snapshot in 0.24 s, 2,625 moves in 2.9 s, undo of that batch in 2.9 s.

## Token cost

What an agent reads back after a large job (`pnpm bench:tokens`, 5,300 operations: 5,000 moves and 300 trashes). Tokens are characters / 4, an approximation.

| Result | Characters | ~Tokens |
|---|---:|---:|
| `wasnew_undo`, every item listed (before summaries) | 1,578,276 | 394,569 |
| `wasnew_undo`, summary + first 20 (now) | 6,746 | 1,687 |
| `wasnew_move`, 5,000 moves (before) | 71 | 18 |
| `wasnew_move`, 5,000 moves (now, with summary) | 249 | 62 |
| `git status --porcelain`, same changes | 343,351 | 85,838 |

The summary the agent reads after that undo:

```text
1,988 × *  sorted/2026/*/ → inbox/ (undone)
1,049 × *.png  sorted/png/ → inbox/ (undone)
1,004 × *.txt  sorted/txt/ → inbox/ (undone)
959 × *.pdf  sorted/pdf/ → inbox/ (undone)
300 × *.tmp  trash → inbox/ (undone)
```

## Comparison

| | wasnew | git | Claude Code checkpoints | Cline checkpoints | Gemini CLI checkpointing | AgentFS |
|---|---|---|---|---|---|---|
| What is tracked | Moves, renames and trashes made through its tools, plus snapshots of file content | Committed content | Edits by Claude's file editing tools | Workspace state committed to a shadow git repo after each tool use | Project state before an approved tool that modifies files | Every file operation, tool call and state change |
| Shell `rm` / `mv` | Not recorded if run directly; the example hook blocks them and points to the tools | Undone only for committed files | Not tracked | Captured at the next commit to the shadow repo | Not stated | Recorded when done inside AgentFS |
| Where it works | Any existing folder | A git repository | The session's project | The workspace | The project | Inside the AgentFS filesystem (SDK, FUSE or NFS mount) |
| Storage | `.wasnew/` in the folder | `.git/` | Session snapshots, deleted about 30 days after last use by default | Shadow git repo, separate from project git | Shadow git repo under `~/.gemini/history/` | One SQLite database file |

Notes from each project's docs: Claude Code does not capture external changes or edits from other concurrent sessions. Cline notes that checkpoints may use significant storage on very large repositories and can slow it down. Gemini CLI checkpointing is off by default. wasnew records the agent, model and reason with each operation. git finds renames by similarity heuristics and does not attribute uncommitted changes to an agent.

Sources: [Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing) · [Cline checkpoints](https://docs.cline.bot/features/checkpoints) · [Gemini CLI checkpointing](https://geminicli.com/docs/cli/checkpointing/) · [AgentFS](https://github.com/tursodatabase/agentfs)

## CLI

```bash
wasnew snapshot -m "before cleanup"   # --if-changed skips it when nothing changed
wasnew watch                  # snapshot whenever the folder changes (safety net for other programs)
wasnew log
wasnew diff <id>              # against now; a second id compares two snapshots
wasnew pending --batch agent-1
wasnew undo --batch agent-1   # -n 3 undoes only the last 3
wasnew redo --batch agent-1   # do it again; -n 3 redoes the last 3 undone
wasnew restore <id> docs/a.md
wasnew plans                  # also: show <id>, approve <id>, apply <id>
wasnew history <path>
wasnew where <path>           # where the file at an old path is now
wasnew lessons                # kinds of operations people undid or kept
wasnew agents                 # each agent's operations and undo rate
wasnew recover                # settle operations a crashed process left half-recorded
wasnew policy
wasnew gc --keep-last 20      # prune the store; dry run unless --apply
wasnew empty-trash --older-than-days 30   # really delete; dry run unless --apply
```

Every command takes `--root <dir>` (default: current folder) and `--json`.

## Library

```ts
import { openVault, isWasnewError } from "wasnew";

const vault = await openVault("C:/Users/me/Downloads");
const by = { agent: "my-agent", reason: "cleanup" };
const before = await vault.snapshot({ label: "before cleanup" });
await vault.move("Screenshot (3).png", "Pictures/2026/Screenshot (3).png", "run-42", by);
await vault.trash("temp.tmp", "run-42", by);
const { undone, skipped } = await vault.undo({ batch: "run-42" });
await vault.redo({ batch: "run-42" });           // changed my mind; undo works on it again
const { avoid } = await vault.lessons();          // what people undid in this folder
const { guard } = await vault.restore(before.id);   // guard undoes the restore too

const plan = await vault.plan([{ op: "move", from: "a.pdf", to: "Docs/a.pdf" }], { by });
if (!plan.issues.length) await vault.apply(plan.id);
await vault.history("Docs/a.pdf");
```

## Principles

- User files are not deleted. Delete means move to trash, and restore saves what it overwrites first. Files are really deleted only by `emptyTrash`, which a person calls and which is not in MCP.
- Moves are journaled. A move across volumes is copy, compare, then remove the original, and it can be undone.
- A crash before the journal write loses nothing. Each operation writes an `inflight` marker first and removes it after the journal entry. `recover` settles leftover markers from what is on disk.
- Same content is stored once (sha256 content addressing). Large files are hashed as a stream.
- Unchanged files are not read again. If size and mtime match the last snapshot, its hash is reused. Files modified within 2 seconds before a snapshot are not trusted and are read next time (git's racy rule).
- One journal writer at a time. A lock file keeps processes from issuing the same sequence number.
- The store is pruned only when asked. `gc` needs a criterion, defaults to a dry run, and always keeps the newest snapshot.

## Storage layout

```
<root>/.wasnew/
  objects/<aa>/<other 62 chars>   content-addressed blobs
  snapshots/<id>.json             snapshot manifests (partial: e.g. the guard before a restore)
  journal.jsonl                   moves, trashes, undos, restores, plans, approvals, app events (append-only)
  trash/<id>/<path>               trash
  plans/<id>.json                 plans
  inflight/<id>.json              operations in progress (empty when all is well)
  policy.json                     policy
  statcache.json                  size + mtime → hash cache
<root>/.wasnewignore              gitignore syntax, left out of snapshots
```

Error codes: `DEST_EXISTS`, `OUTSIDE_ROOT`, `IN_STORE`, `NOT_FOUND`, `CROSS_DEVICE_DIR`, `COPY_MISMATCH`, `SNAPSHOT_NOT_FOUND`, `NOT_IN_SNAPSHOT`, `BAD_SNAPSHOT_ID`, `POLICY_INVALID`, `POLICY_PROTECTED`, `POLICY_LIMIT`, `POLICY_DENIED`, `NEEDS_APPROVAL`, `PLAN_NOT_FOUND`, `PLAN_INVALID`, `PLAN_APPLIED`, `RESERVED_OP`, `LOCKED`, `GC_NEEDS_POLICY`.

## Development

```bash
pnpm test        # 130 tests: snapshots, stat cache, watch, restore guard, cross-volume moves, locks, trash, provenance, policy, plan/approve, recovery, MCP round trips, hooks, summaries, lessons, trust, redo
pnpm typecheck
pnpm build       # CLI and MCP server into dist/
pnpm bench       # also bench:git, bench:tokens
```

wasnew started as the undo layer under the file organizing engine of the ISNEW app.

## Limits

- MCP is tested with real stdio round trips. It has not yet been run attached to the Claude Desktop or Claude Code clients.
- CI runs the tests on Ubuntu, Windows and macOS with Node 20 and 22. Benchmarks come from single machines, listed with each table.
- The policy file can't be changed through wasnew tools, but nothing stops an agent from editing it with another tool.
- `maxOpsPerBatch` counts only operations that carry a batch.
- A whole folder can't be moved across volumes (`CROSS_DEVICE_DIR`). Move its files one by one.
- `diff` against the current files hashes every file.
- A program that changes content and then sets size and mtime back can fool the cache. Use `snapshot --rehash` then.
- `watch` uses Node's recursive `fs.watch`. Network drives may not send change events.

## FAQ

### Can Claude Code undo rm or mv?

Not through checkpoints: the docs say files changed by Bash commands such as `rm`, `mv` and `cp` are not tracked. With wasnew the agent uses `wasnew_trash` and `wasnew_move` instead, and the [hook example](examples/claude-code/) blocks the shell versions.

### How do I undo files an AI agent deleted?

If the agent used `wasnew_trash`, run `wasnew undo --batch <batch>` (or ask the agent to call `wasnew_undo`). If something deleted files outside wasnew and a snapshot exists, `wasnew restore <snapshot>` brings back their content. See [CLI](#cli).

### Does it need git?

No. It works in any folder and keeps its data in `.wasnew/` inside that folder. It also works inside a git repository, alongside git.

### How is this different from Claude Code checkpoints?

Checkpoints cover edits made by Claude's file editing tools within a session. wasnew covers moves, renames and deletes in any folder, records which agent did each one and why, and keeps the journal in the folder across sessions. See [Comparison](#comparison).

### How do I stop an agent from running rm -rf?

In Claude Code, add the `PreToolUse` hook from [examples/claude-code](examples/claude-code/). It blocks `rm`, `mv`, `del`, `Remove-Item`, `git clean`, `git reset --hard` and `find -delete` and tells the agent to use the wasnew tools. It matches command text, so a script that deletes files on its own is not caught; keep the snapshot hook or `wasnew watch` running as a backstop.

### Can an agent approve its own plan?

No. There is no approve tool in MCP. A person runs `wasnew approve <id>` in a terminal, and `wasnew_apply` refuses with `NEEDS_APPROVAL` until then. See [Plan → approve → apply](#plan--approve--apply).

### Does it work with Codex, Gemini CLI or Cursor?

Any MCP client can use the 16 tools; run `wasnew mcp --root <folder>` as a stdio server in that client's MCP settings. The shell-blocking and moved-file hooks are written for Claude Code's hook format.

### How much disk does it use?

The first snapshot stores one copy of every file's content, about the size of the folder (2,048 MB for 2 GB of media in the [benchmark](#benchmarks)). Later snapshots add only new content, and moves and trash are renames that add nothing. `wasnew gc` and `wasnew empty-trash` free space.

### What happens if the process crashes mid-move?

Each operation writes an `inflight` marker before touching files and removes it after the journal entry. `wasnew recover` reads leftover markers, checks the disk, and records what actually happened, so the move can still be undone.

### Where does an agent find a file that was moved?

`wasnew_where` follows the journal to the current path, and failed calls on a missing path include `movedTo`. In Claude Code, the moved-file hook stops `Read` and `Edit` on a gone path and gives the new one.

## License

Code is MIT. The name and logo are not covered by the license ([NOTICE](NOTICE)).
