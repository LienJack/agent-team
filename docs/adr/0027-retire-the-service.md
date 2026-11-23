# 0027 退役 agent-team 服務，只保留 t3-team skill

狀態：採用（2026-11-23；取代 spec v2 的整個服務，ADR 0001–0025 留作歷史）

**背景**：agent-team 自己實作了多 agent 開發所需的一切：Node 服務、SQLite、engine、各家 CLI 的 runner 與沙箱、
看板、CLI、MCP、Grok 中樞。T3 Code 已經提供其中大部分（多家模型的子 agent、worktree、thread 介面、排程、遠端存取），
而且更成熟。擁有者的判斷：agent-team 在重複造輪子，真正要保留的是 Team Leader 的協調能力（需求與架構討論、拆單、
派給合適的 agent、把關、審查、合併前問人）。

**決定**：

1. 刪除服務的全部程式與設定（`apps/`、`packages/`、`tools/`、`config/`、pnpm/TypeScript 工具鏈、`team-agent` skill、
   服務規格 `docs/spec.md` 等）。它們留在 git 歷史（本分支之前的 `main`）。
2. repo 只保留 `skills/t3-team/`：SKILL.md（五個階段）、`roles.json`（模型分工）、`roles_check.py`、`gate.py`（把關，
   取代服務的 `POST /api/gate`，見 ADR 0026 的更新）與測試。
3. 原服務的保證改由以下方式承擔：服務端核對 → `gate.py`；跨模型審查 → T3 delegate；專案記憶 → plan.md 與專案
   文件（OpenSpec 歸檔的規格）；調研 → research delegate；Grok 通知 → T3 自己的遠端存取。

**失去的**：worker 沙箱（T3 的 worker 用 T3 的權限）、engine 的派工編號柵欄與啟動復原、額度冷卻與熔斷、看板。
需要這些時，從 git 歷史還原服務即可。

**依據**：2026-11-23 用 t3-team 在 learn-anything 實跑：拆單、並行派工（Opus／Codex／Sonnet）、`gate.py` 核對、跨家族
審查、修正輪、合併，完成教材與問答模式並寫出 9 章教材；每張單的指標記在
`~/RanoLabs/research/agent-team/t3-team-metrics/metrics.jsonl`。
