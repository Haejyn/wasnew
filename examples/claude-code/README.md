# Claude Code 와 함께 쓰기

에이전트 체크포인트는 에이전트가 편집한 파일만 되돌립니다. 셸에서 실행한 `rm` · `mv` 와 git 밖 폴더는 이 예제가 맡습니다.

## 1. MCP 서버 붙이기

```bash
claude mcp add --transport stdio wasnew -- node /path/to/wasnew/bin/wasnew.js mcp --root ~/Downloads
```

## 2. 훅 세 개 (`settings.json`)

| 훅 | 하는 일 |
|---|---|
| `UserPromptSubmit` | 요청을 보낼 때마다 `$WASNEW_ROOT` 폴더를 스냅샷(`--if-changed`면 바뀐 게 없을 때 건너뜀). 안 바뀐 파일은 다시 읽지 않아 빠름 |
| `PreToolUse` · `Bash` | [`guard.mjs`](guard.mjs) 가 `rm` · `mv` · `del` · `Remove-Item` · `git clean` · `git reset --hard` · `find -delete` 를 막고, 대신 `wasnew_trash` · `wasnew_move` 를 쓰라고 에이전트에게 돌려줌 |
| `PreToolUse` · `Read` · `Edit` | [`moved.mjs`](moved.mjs) 가 없는 파일을 열려고 할 때 저널에 옮겨진 기록이 있으면 막고 새 경로를 알려 줌. 휴지통에 있으면 되돌릴 batch 를 알려 줌. 새 파일을 만드는 `Write` 는 늘 통과. 파일이 있거나 기록이 없으면 그냥 통과 |

[`settings.json`](settings.json) 의 경로를 바꿔 `~/.claude/settings.json` 이나 프로젝트의 `.claude/settings.json` 에 합치세요. `WASNEW_ROOT` 는 지킬 폴더입니다.
Windows 에서는 훅 명령이 PowerShell 로 돌아 `$WASNEW_ROOT` 가 펼쳐지지 않습니다. 폴더 경로를 직접 적으세요.

## 3. 큰 작업은 승인 받기

`<폴더>/.wasnew/policy.json`:

```json
{ "protect": ["Taxes/", "*.key"], "requireApprovalOver": 20, "maxOpsPerBatch": 1000 }
```

20개가 넘는 이동 · 휴지통은 에이전트가 `wasnew_plan` 으로 제안만 할 수 있습니다. 터미널에서 확인하고 승인합니다:

```bash
wasnew plans
wasnew show <id>
wasnew approve <id>
```

그다음 에이전트가 `wasnew_apply` 로 실행합니다. 승인 도구는 MCP 에 없어서 에이전트가 스스로 승인할 수 없습니다.

## 제한

- `guard.mjs` 는 명령 문자열을 패턴으로 봅니다. 스크립트 파일 안에서 지우거나 다른 언어로 지우는 것은 못 막습니다. 그래서 스냅샷 훅을 같이 쓰고, 더 촘촘히 지키려면 `wasnew watch --root <폴더>` 를 따로 띄워 둡니다
- 정책 파일은 wasnew 도구로는 고칠 수 없지만, 에이전트가 다른 편집 도구로 고치는 것까지 막지는 않습니다
