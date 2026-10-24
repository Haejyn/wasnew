# Problems solved

English | [한국어](problems.ko.md)

One record per problem. Facts come from commit messages and the README benchmarks. `[to confirm]` marks what is not written down anywhere yet.

## Shell rm and mv by an agent cannot be undone

- Found: [to confirm]
- Cause: the Claude Code docs say checkpointing does not track files changed by Bash commands. git covers committed files only.
- Fix: move and trash MCP tools, and a journal entry with who and why for every operation. A hook blocks shell `rm` and `mv` and tells the agent to use the tools.
- Check: a real Claude Code session run headless and recorded (2f9fa80).
- Result: after sorting 199 files, `wasnew undo` put all 199 back.
- Left: an agent that deletes through the shell with no hook installed is not recorded. `watch` snapshots are the fallback.
- Commits: d0c8cf2, 9458655, 2f9fa80

## Bulk operations are slow

- Found: [to confirm]
- Cause: one lock and one journal write per operation.
- Fix: group commit of 256 operations at a time. Moves are renames.
- Check: `scripts/bench-git.mjs` runs the same jobs against git, median of 3 runs.
- Result: reorganizing 8 files × 256 MB takes 11 ms against 11,458 ms for git. Undo takes 12 ms against 8,667 ms.
- Left: re-snapshotting 5,000 unchanged small files is slower than git (151 ms against 57 ms). The first snapshot store is about the size of the source (2,048 MB), since identical content is stored once but nothing is compressed.
- Commits: 1cc6eb8

## Big results fill the agent's context

- Found: [to confirm]
- Cause: a 5,300-item result came back in full.
- Fix: a few lines of pattern summary and the first 20 items. The full list only with `full: true`.
- Check: `pnpm bench:tokens`
- Result: about 394,569 tokens down to 1,687. `git status` for the same changes is about 85,838.
- Left: [to confirm]
- Commits: d83f86e

## An agent in a later session looks for a moved file at its old path

- Found: [to confirm]
- Cause: the agent does not know the file moved.
- Fix: `where()` follows a path through moves, folder moves, trash and undo. Failed calls on a gone path carry `movedTo`. A Read/Edit hook uses it.
- Check: tests, and the invoice_oct.pdf scene in the demo.
- Result: reading the old path is blocked and the agent gets the new path.
- Left: [to confirm]
- Commits: d83f86e

## The moved-file hook blocks normal work

- Found: [to confirm]
- Cause: it also blocked creating a new file at a name that had moved.
- Fix: Write is never blocked. An agent that means the old file reads or edits it first and gets the new path there.
- Check: tests
- Result: the over-blocking is gone.
- Left: [to confirm]
- Commits: 9296c15

## Concurrent runs fail on Windows

- Found: [to confirm: CI or local]
- Cause: opening the lock file while the previous holder is still deleting it returns EPERM. Two snapshots replacing statcache.json at once make the rename fail with EPERM.
- Fix: EPERM on the lock means wait, like EEXIST. The statcache rename retries briefly, then skips the cache, and never leaves the temp file behind.
- Check: CI on ubuntu, windows and macos with Node 20 and 22.
- Result: [to confirm]
- Left: [to confirm]
- Commits: b7bbc82, a3252f9

## Undo lessons could carry instructions to another agent

- Found: [to confirm]
- Cause: a past agent's `reason` text went into a new agent's MCP instructions.
- Fix: `reason` appears only in `wasnew_lessons` output. Instructions carry only counted patterns.
- Check: tests
- Result: one prompt injection path closed.
- Left: the trust policy is a convenience, not a security boundary. A client can send any name (stated in the README).
- Commits: 378689b

## Updating a client resets its trust record

- Found: [to confirm]
- Cause: `claude-code 2.1.0` and `2.2.0` counted as two agents.
- Fix: records are grouped by client name without the version.
- Check: tests
- Result: the undo ratio and trust carry over after an update.
- Left: same as above, client names are not verified.
- Commits: 378689b

## Tests time out on slow CI runners

- Found: CI, windows-latest with Node 20.
- Cause: the 600-file group commit test took longer than the 5 s default there.
- Fix: test timeout 30 s.
- Check: CI rerun
- Result: passes.
- Left: [to confirm]
- Commits: 8996ed5

## Open problems

- Re-snapshotting 5,000 unchanged small files is slower than git (151 ms against 57 ms). wasnew stats each file from Node, while git uses its cached directory scan on Windows. The README states the cause.
- The first snapshot store is about the size of the source (2,048 MB). Identical content is stored once, but nothing is compressed.
- The trust policy is a convenience, not a security boundary. A client can send any name (stated in the README).
- An agent that deletes through the shell without the hook is not recorded. `watch` snapshots are the fallback.
- Not published to npm yet, and there are no outside users.
