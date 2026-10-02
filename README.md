<p align="center"><img src="assets/icon-512.png" width="128" alt="wasnew"></p>

# wasnew

AI 에이전트가 파일을 만질 때 쓰는 되돌리기. 에이전트는 계획하고, 사람은 승인하고, 무엇이든 되돌린다. 누가 · 왜 했는지 남고, 사용자 파일은 지우지 않는다.

![tests](https://img.shields.io/badge/tests-78%20passed-16a34a)
![node](https://img.shields.io/badge/node-%E2%89%A520-339933)
![deps](https://img.shields.io/badge/dependencies-0-111111)
![mcp](https://img.shields.io/badge/MCP-12%20tools-111111)
![license](https://img.shields.io/badge/license-MIT-blue)

> 아이콘은 삭(新月), 달이 새것(new)이었던(was) 순간입니다. 아래 머리카락만 한 빛이 곧 [willnew](https://github.com/Haejyn/willnew) 의 초승달이 됩니다.

## 왜

- 에이전트 체크포인트는 에이전트가 **편집한** 파일만 되돌린다. 셸에서 한 `rm` · `mv`, git 밖 폴더(다운로드 · 바탕화면 · NAS)는 대상이 아니다
- git 은 사람이 커밋하는 코드용이다. `reset --hard` · `clean` 처럼 지우는 길이 있고, 이동은 기록하지 않고 추론한다
- 백업 도구는 무엇이 일어났는지 모른다. 이동 기록도, 작업 단위도, 누가 했는지도 없다

wasnew 는 그 사이에 선다 — **아무 폴더에서, 에이전트의 작업 단위로, 누가 · 왜를 남기며** 되돌린다.

| | git | wasnew |
|---|---|---|
| 대상 | 코드, 사람이 커밋 | 아무 폴더, 프로그램이 조작 |
| 필요한 것 | git 바이너리 | Node 20+, 의존성 0개, `.wasnew/` 폴더 하나 |
| 지우기 | `reset --hard` · `clean` | 휴지통으로 옮길 뿐. 진짜 삭제는 사람의 `empty-trash` 뿐 |
| 이동 | 삭제 + 추가로 추론 | 저널에 기록, 작업(batch) 단위로 되돌림 |
| 누가 · 왜 | 커밋 작성자 | 이동마다 에이전트 · 모델 · 사유, `history` 로 파일의 이름 변천까지 |
| 큰 변경 | 리뷰는 저장소 밖의 일 | 정책을 넘으면 계획만 가능, 사람이 `approve` 해야 적용 |
| 되돌리기 충돌 | 사람이 해결 | 원래 자리에 새 파일이 있으면 덮지 않고 이유와 함께 건너뜀 |

## 에이전트에 붙이기 (MCP)

```bash
pnpm install && pnpm build
claude mcp add --transport stdio wasnew -- node /path/to/wasnew/bin/wasnew.js mcp --root ~/Downloads
```

Claude Desktop 은 `claude_desktop_config.json` 에:

```json
{ "mcpServers": { "wasnew": { "command": "node", "args": ["/path/to/wasnew/bin/wasnew.js", "mcp", "--root", "C:/Users/me/Downloads"] } } }
```

| 도구 | 하는 일 |
|---|---|
| `wasnew_snapshot` | 지금 내용을 저장. 여러 파일을 바꾸기 전에 |
| `wasnew_move` | 이동 · 이름 바꾸기. 목적지가 있으면 `DEST_EXISTS` 로 거부. 작업마다 batch 하나, `reason` 으로 사유 |
| `wasnew_trash` | 지우기 대신 휴지통으로. `wasnew_undo` 로 되돌림 |
| `wasnew_plan` | 이동 · 휴지통 목록을 아무것도 건드리지 않고 검사 — 조작마다 문제, 승인 필요 여부 |
| `wasnew_apply` | 계획을 정확히 그대로, 한 번만, 한 batch 로. 승인 전이면 `NEEDS_APPROVAL`, 그 사이 폴더가 바뀌었으면 `PLAN_INVALID` |
| `wasnew_undo` | 묶음 전체, 묶음의 마지막 N개, 또는 마지막 N개를 되돌림. 못 되돌린 것은 이유와 함께 |
| `wasnew_restore` | 스냅샷 내용으로 복원. 덮어쓸 파일은 먼저 `guard` 스냅샷으로 저장 |
| `wasnew_diff` | 추가 · 변경 · 사라짐 · 이동(내용 해시로 감지). 사용자에게 한 일을 설명할 때 |
| `wasnew_history` | 한 파일의 이동 · 휴지통 · 되돌림 · 복원 — 언제, 누가, 왜 |
| `wasnew_read` | 파일을 그 시점의 내용으로 읽기 |
| `wasnew_log` · `wasnew_pending` | 스냅샷 목록 · 아직 되돌릴 수 있는 것 |

- 접속한 클라이언트 이름(`clientInfo`)이 에이전트로 기록되고, 모델은 `model` · `reason` 을 덧붙인다
- **승인 도구는 MCP 에 없다** — 에이전트는 스스로 승인할 수 없다
- 기본은 `--root` 안의 파일만 옮긴다. 밖에서 가져오는 일은 `--allow-outside-sources` 로 켠다
- 도구 실패는 프로토콜 에러가 아니라 `isError` 결과로 돌아온다 — 에이전트가 코드를 읽고 고쳐서 다시 시도한다
- 셸의 `rm` · `mv` 까지 막으려면 [Claude Code 훅 예제](examples/claude-code/)

## 정책 — `.wasnew/policy.json`

```json
{ "protect": ["Taxes/", "*.key"], "requireApprovalOver": 20, "maxOpsPerBatch": 1000, "allowTrash": true }
```

| 키 | 뜻 |
|---|---|
| `protect` | gitignore 문법. 옮기기 · 휴지통 · 그 자리로 옮겨 오기 모두 거부. 보호된 파일을 품은 폴더도 |
| `requireApprovalOver` | 이보다 많은 조작은 계획 → 사람의 `approve` → 적용으로만 |
| `maxOpsPerBatch` | 한 batch 의 최대 조작 수 (폭발 반경) |
| `allowTrash` | `false` 면 휴지통도 끔 |

잘못된 정책은 닫힌 쪽으로 실패한다 — 고칠 때까지 모든 조작이 `POLICY_INVALID`.

## 계획 → 승인 → 적용

```text
agent  wasnew_plan   → plan baebff75: 3 operations, needs the user's approval
person wasnew show baebff75
person wasnew approve baebff75
agent  wasnew_apply  → done 3, batch plan-baebff75
person wasnew history "copy of notes.md"
       trash  copy of notes.md -> trash/…  by claude-code 2.1.0 — sort Downloads
person wasnew undo --batch plan-baebff75
```

계획은 앞선 조작의 결과를 따라가며 검사한다 — 이미 옮겨진 원본, 계획 안에서 겹치는 목적지, 보호 경로, 한도를 조작 번호와 함께 알려 준다.

## 실측

| 항목 | 결과 |
|---|---|
| 스냅샷 — 파일 2,626개(1 GiB 하나 포함) | 5.4 s, 최대 RSS 162 MB (스트리밍 해시, 파일을 통째로 올리지 않음) |
| 같은 폴더 다시 스냅샷 | 0.24 s, 다시 읽은 파일 0개 (크기 · 수정 시각 캐시) |
| 이동 2,625건 (저널 잠금 · 크래시 표식 포함) | 2.9 s |
| 그 묶음 되돌리기 | 2.9 s, 2,625건 전부, 빈 폴더 정리 |

- 세 번 잰 중앙값. Linux · Intel Xeon 2.1 GHz 4코어 · Node 22.22 · 2026-10-02 (`pnpm bench`)

## CLI

```bash
wasnew snapshot -m "정리 전"  # --if-changed 면 같은 상태는 다시 안 남김
wasnew watch                  # 폴더가 바뀔 때마다 스냅샷 (wasnew 를 안 쓰는 프로그램용 안전망)
wasnew log
wasnew diff <id>              # 지금과 비교, 두 번째 id 를 주면 스냅샷끼리
wasnew pending --batch agent-1
wasnew undo --batch agent-1   # -n 3 이면 마지막 3개만
wasnew restore <id> docs/a.md
wasnew plans · show <id> · approve <id> · apply <id>
wasnew history <path>
wasnew recover                # 죽은 프로세스가 남긴 반쯤 기록된 조작 정리
wasnew policy
wasnew gc --keep-last 20      # 저장소 정리, 미리보기 · --apply 로 실행
wasnew empty-trash --older-than-days 30   # 진짜 삭제, 미리보기 · --apply 로 실행
```

모든 명령에 `--root <폴더>`(기본 현재 폴더) · `--json`.

## 라이브러리

```ts
import { openVault, isWasnewError } from "wasnew";

const vault = await openVault("C:/Users/me/Downloads");
const by = { agent: "my-agent", reason: "정리" };
const before = await vault.snapshot({ label: "정리 전" });
await vault.move("스크린샷 (3).png", "Pictures/2026/스크린샷 (3).png", "run-42", by);
await vault.trash("임시.tmp", "run-42", by);
const { undone, skipped } = await vault.undo({ batch: "run-42" });
const { guard } = await vault.restore(before.id);   // guard 로 복원도 되돌린다

const plan = await vault.plan([{ op: "move", from: "a.pdf", to: "Docs/a.pdf" }], { by });
if (!plan.issues.length) await vault.apply(plan.id);
await vault.history("Docs/a.pdf");
```

## 원칙

- **사용자 파일을 지우지 않는다.** 지우기는 휴지통으로 옮기기이고, 복원은 덮어쓸 내용을 먼저 저장한다. 진짜 삭제는 사람이 부르는 `emptyTrash` 하나뿐이고 MCP 에는 없다
- **이동은 저널로.** 볼륨을 넘은 이동도 복사 → 대조 → 원본 삭제로 하고 되돌린다
- **기록 전에 죽어도 잃지 않는다.** 조작마다 `inflight` 표식을 먼저 쓰고, 저널에 쓴 뒤 지운다. `recover` 가 남은 표식을 디스크 상태로 판정해 저널에 올린다
- **같은 내용은 한 번만 저장** (sha256 내용주소). 큰 파일은 흘려 보내며 해시한다
- **안 바뀐 파일은 다시 읽지 않는다.** 크기 · 수정 시각이 지난 스냅샷과 같으면 그 해시를 쓴다. 스냅샷 직전 2초 안에 수정된 파일은 믿지 않고 다음에 다시 읽는다 (git 의 racy 규칙)
- **저널은 한 번에 한 작성자.** 잠금 파일로 여러 프로세스가 같은 번호를 내지 않게 한다
- **저장소 정리는 명시적으로만.** `gc` 는 기준이 있어야 돌고, 기본이 미리보기이며, 가장 최근 스냅샷은 늘 남긴다

## 저장 구조

```
<root>/.wasnew/
  objects/<aa>/<나머지 62자>   내용주소 blob
  snapshots/<id>.json         스냅샷 manifest (partial: 복원 전 guard 처럼 일부만 담은 것)
  journal.jsonl               이동 · 휴지통 · 되돌림 · 복원 · 계획 · 승인 · 앱 이벤트 (append-only)
  trash/<id>/<path>           휴지통
  plans/<id>.json             계획
  inflight/<id>.json          진행 중인 조작 (정상이면 비어 있다)
  policy.json                 정책
  statcache.json              크기 · 수정 시각 → 해시 캐시
<root>/.wasnewignore          gitignore 문법, 스냅샷에서 뺄 것
```

에러 코드: `DEST_EXISTS` · `OUTSIDE_ROOT` · `IN_STORE` · `NOT_FOUND` · `CROSS_DEVICE_DIR` · `COPY_MISMATCH` · `SNAPSHOT_NOT_FOUND` · `NOT_IN_SNAPSHOT` · `BAD_SNAPSHOT_ID` · `POLICY_INVALID` · `POLICY_PROTECTED` · `POLICY_LIMIT` · `POLICY_DENIED` · `NEEDS_APPROVAL` · `PLAN_NOT_FOUND` · `PLAN_INVALID` · `PLAN_APPLIED` · `RESERVED_OP` · `LOCKED` · `GC_NEEDS_POLICY`.

## 개발

```bash
pnpm test        # 78개 — 스냅샷 · stat 캐시 · watch · 복원 guard · 볼륨 간 이동 · 잠금 · 휴지통 · 출처 · 정책 · 계획/승인 · 복구 · MCP 왕복 · 훅
pnpm typecheck
pnpm build       # dist/ — CLI 와 MCP 서버
pnpm bench
```

wasnew 는 ISNEW 앱의 파일 정리 엔진이 쓰는 되돌리기 계층으로 처음 만들어졌습니다.

## 제한

- MCP 는 실제 stdio 왕복과 테스트로 검증했습니다. Claude Desktop · Claude Code 클라이언트에 붙여서는 아직 돌려 보지 않았습니다
- 테스트는 CI 에서 ubuntu · windows · macOS × Node 20 · 22 로 돕니다. 실측 숫자는 Linux 한 대에서만 쟀습니다
- 정책 파일은 wasnew 도구로는 못 고치지만, 에이전트가 다른 편집 도구로 고치는 것까지 막지는 않습니다
- `maxOpsPerBatch` 는 batch 를 단 조작만 셉니다
- 볼륨을 넘어 폴더를 통째로 옮기지 못합니다(`CROSS_DEVICE_DIR`) — 파일 단위로
- 지금과 비교하는 `diff` 는 모든 파일을 해시합니다
- 내용을 바꾸면서 크기와 수정 시각까지 되돌려 놓는 프로그램은 캐시를 속일 수 있습니다 — 그럴 땐 `snapshot --rehash`
- `watch` 는 Node 의 재귀 감시(`fs.watch`)를 씁니다. 네트워크 드라이브에서는 변경 알림이 오지 않을 수 있습니다

코드는 MIT. 이름과 로고는 라이선스에 포함되지 않아요([NOTICE](NOTICE)).
