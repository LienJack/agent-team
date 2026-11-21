# agent-team

在這台 Mac 上執行的多 agent 開發服務。一支 Node 服務持有全部狀態（SQLite）與一個無頭的 **Team Leader**
（Claude 對話）；實作與審查交給一次性的 worker（Claude／Codex／dsh），worker 只交結構化回執，由服務端核對
git 變更、跑機器檢查並代為 commit。你可以從**看板**（區網內的手機、平板也行）、**CLI**（`team`）、**MCP**
（Claude／Codex 桌面版）或 **Grok**（手機，預設關閉）跟它說話。

完整規格在 [`docs/spec.md`](docs/spec.md)，重要決定在 [`docs/adr/`](docs/adr/)，開發規範在 [`AGENTS.md`](AGENTS.md)。

## 需求

| 項目                    | 說明                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| Node.js ≥ 26            | `node --version`                                                                                    |
| pnpm 11.25.0            | `corepack enable`（版本取自 `package.json` 的 `packageManager`）                                    |
| git                     | 任務 worktree 與服務端 commit                                                                       |
| Claude Code（`claude`） | leader 與 claude worker；先 `claude` 登入一次                                                       |
| Codex                   | codex worker；`@openai/codex-sdk` 自帶執行檔，用 ChatGPT 帳號登入（`codex login`，共用 `~/.codex`） |
| dsh（選用）             | dsh worker（經 OpenRouter，按量計費），需要 `OPENROUTER_API_KEY`                                    |
| grokmsg（選用）         | 只有開啟 Grok 橋接才需要                                                                            |
| Google Chrome（選用）   | 只給 `pnpm test:e2e`；有 Playwright 自帶的 Chromium 時不需要                                        |

不用 Docker，不需要全域安裝任何套件。

## 安裝

```sh
git clone <repo> agent-team && cd agent-team
HUSKY=0 pnpm install      # HUSKY=0：不安裝 git hook（需要時再 pnpm hooks:install）
pnpm build                # tsc -b + vite build（leader 用的 team 指令與看板都在 dist/）
```

方便起見，把 `team` 設成別名（路徑換成你的 checkout）：

```sh
alias team="node /ABS/PATH/agent-team/apps/cli/dist/bin.js"
```

## `.env`

複製 `.env.example` 成 `.env`（git 忽略；`AGENT_TEAM_ENV_FILE` 可改指別的位置），只填你用得到的：

| 變數                                     | 用途                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`                     | dsh worker 與 `hub_summarizer`（經 OpenRouter）；只會放進 dsh 子行程的環境 |
| `TEAM_LAN_PASSWORD`                      | 看板登入密碼；留空則每次啟動產生一組，只在終端機印一次                     |
| `JEV_API_KEY`、`JEV_URL`、`JEV_PROVIDER` | Jev 判定關卡（預設關閉，v1 不用）                                          |

秘密不會進資料庫、日誌、API 回應或 worker 的派工單。`team doctor` 只顯示「有／沒有」，不顯示值。

## 啟動

```sh
pnpm start        # 需要時先建置，再從 dist 啟動（前景執行）
# 或（已建置過）
team serve
```

啟動時會印出：

```
區網看板密碼（只顯示這一次）：xxxx-xxxx-xxxx-xxxx   ← 只有 .env 沒設 TEAM_LAN_PASSWORD 時
看板（這台電腦）：http://127.0.0.1:4518
區網看板：http://192.168.x.y:4518
```

Ctrl-C 正常關機：執行中的 worker 整個行程群組會被終止，它們的 run 標為 `abandoned`、任務重新排入並附上復原說明，
下次啟動接著做（再按一次 Ctrl-C 會強制結束）。

### 打開看板

- **這台 Mac**：瀏覽器開 `http://127.0.0.1:4518`，輸入密碼。
- **區網內的其他裝置**：開 `http://<這台 Mac 的區網 IP>:4518`（上面印出的「區網看板」網址），輸入密碼。
  連續輸錯 5 次會鎖 15 分鐘。區網是未加密的 HTTP，請只在信任的網路使用。

看板只在區網監聽埠（預設 `0.0.0.0:4518`）提供；本機監聽埠 `127.0.0.1:4517` 只給 CLI／MCP，用 `listener.json`
裡的權杖，不提供頁面。區網上不能新增專案或改設定（這兩件事只能在這台電腦用 CLI 做）。

## 第一個專案與任務

```sh
# 註冊 repo（主 checkout 的絕對或相對路徑），可加機器檢查
team project add demo ~/code/demo --base main --check "test=pnpm test" --check "lint=pnpm lint"

# 建一張派工單並排入佇列（派工單從 stdin）
team task add --project demo --title "登入頁加上記住我" --tier C --paths "src/login/" --queue - <<'EOF'
# 登入頁加上記住我
勾選後 30 天內免登入。
## 驗收標準
- pnpm test 通過
EOF

team status            # 看板摘要
team watch             # 即時事件（Ctrl-C 結束）
team receipt <task_id> # 最新回執
```

或者直接跟 leader 說：`team ask "幫 demo 的登入頁加上記住我，拆成派工單"`。

任務的流程：`draft → queued → running → verifying → review → done`（旁支 `blocked`、`failed`、`cancelled`）。
worktree 在 `~/RanoLabs/worktrees/<project>/<task_id>/`，分支 `team/<task_id>`；分支永遠保留，不會自動合併回主幹。

## CLI 速查

| 指令                                                                                              | 說明                                                                                       |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `team serve`                                                                                      | 前景執行服務                                                                               |
| `team status` / `team doctor` / `team resume`                                                     | 看板摘要／環境與 runner 檢查／不經模型的現況摘要                                           |
| `team watch [--after seq]`                                                                        | 每個事件一行，斷線自動接續                                                                 |
| `team roles`                                                                                      | `config/models.json` 的角色、別名、runner、槽位                                            |
| `team project add <name> <repo> [--base B] [--check "name=cmd"]… [--allow-network]`               | 註冊專案（僅本機）；`--allow-network` 讓 worker 沙箱可連公開網路（預設關閉，建立後不能改） |
| `team task add --project P --title T --tier A\|B\|C --paths "…" (--ticket-file F \| -) [--queue]` | 建任務                                                                                     |
| `team task list [--project P] [--status queued,running]` / `team task show <id>`                  | 列出／詳情                                                                                 |
| `team task queue\|cancel\|retry <id>`                                                             | 排入／停止並取消／重試                                                                     |
| `team task reassign <id> <role>`                                                                  | 改派角色（先檢查角色存在且啟用）                                                           |
| `team receipt <task_id>`                                                                          | 最新回執                                                                                   |
| `team ask "<text>"`                                                                               | 對 leader 說話，等到回覆為止；Ctrl-C 只停止等待（訊息保留，回覆會出現在看板聊天）          |
| `team leader reset`                                                                               | 開新的 leader 對話（例如換了 Claude 登入）                                                 |
| `team attention list` / `open --question Q --option A …` / `answer <id> "<答案>"`                 | 待決事項                                                                                   |

每個指令都可加 `--json`。結束碼：0 成功、1 業務錯誤、2 用法或連線錯誤（`team ask` 被 Ctrl-C 中止是 130）。

## MCP（Claude／Codex 桌面版）

工具：`ask_leader`、`status`、`list_attention`、`answer_attention`、`task_action`（細節見
[`apps/mcp/README.md`](apps/mcp/README.md)）。`/ABS/PATH/agent-team` 換成本 repo 的絕對路徑；資料目錄不在預設位置時
加上 `AGENT_TEAM_HOME`。

Claude Code：

```sh
claude mcp add agent-team -- node /ABS/PATH/agent-team/apps/mcp/dist/bin.js
```

或 `.mcp.json`：

```json
{
  "mcpServers": {
    "agent-team": {
      "command": "node",
      "args": ["/ABS/PATH/agent-team/apps/mcp/dist/bin.js"]
    }
  }
}
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.agent-team]
command = "node"
args = ["/ABS/PATH/agent-team/apps/mcp/dist/bin.js"]
```

## 模型路由（`config/models.json`）

- `models`：模型別名 → `runner`（claude／codex／dsh）、`model`、`effort`、牌價。換模型版本只改這裡的 `model`。
- `roles`：角色 → `use`（第一選擇的別名）、`fallback`（依序替補）、`slots`（同時幾個）、`escalate_to`（修正幾輪
  仍不過時升級到哪個角色）、`enabled`。實作角色 `impl_A／B／C`、審查角色 `review_A／B／C` 必須存在；審查者的別名
  不得與最近一次實作者相同。
- `rules`：修正輪數上限、額度規則（Claude 使用率高或 Codex 額度低時改用哪個別名）。

改完重新啟動服務生效（檔案有錯會在啟動時說明哪一行）。`team roles` 或 `GET /api/roles` 確認結果。其他設定
（埠、並行上限、逾時、清理時間、leader、Grok）在 `config/service.json`，每個欄位都有預設值。

leader 由 `service.json` 的 `leader.enabled` 控制（預設開），與 worker 是否用假 runner 無關：
`AGENT_TEAM_FAKE_RUNNERS=1 team serve` 會讓 worker 全部用行程內的假 runner、但 leader 仍是真的 Claude，這是最便宜的
真實端到端組合。

## Grok 橋接

預設關閉。開啟前**先停掉現有的中樞 session（「Grok bot 中樞整理」）**：兩者監看同一個 `grokmsg` 收件匣，同時開會
重複處理、重複回覆。

1. 確認 `grokmsg` 在 PATH 上。
2. `config/service.json` 設 `"grok": { "enabled": true }`（可另設合併視窗、安靜時段、整理門檻）。
3. 重新啟動服務。

開啟後：Grok 來的訊息原文交給 leader；回覆、待決事項（問題與選項原樣帶按鈕）與主動通知（完成、失敗、阻塞、
額度用完、熔斷）先寫 outbox 再送，相同特徵不會重發（重啟後亦然）。

## 換一個 Claude 登入繼續

leader 遇到未登入或額度用完時會標為不可用，訊息保留、恢復後依序回覆（看板頂部與 `team status` 會顯示原因）。
要改用另一個帳號：

```sh
claude          # 在這台電腦用另一個帳號登入（/login）
team leader reset
```

`reset` 開一個新的 leader 對話，第一個 turn 先附上不經模型產生的現況摘要（`team resume` 看得到同一份），任務狀態
全部在資料庫裡，不會遺失。

## 資料放在哪裡

| 內容                        | 位置                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 資料目錄 `DATA`             | `~/.agent-team/`（`AGENT_TEAM_HOME` 可改）                                                                           |
| 資料庫                      | `DATA/team.db`（SQLite，WAL）                                                                                        |
| 連線資訊（CLI／MCP 自動讀） | `DATA/run/listener.json`（0600，每次啟動換新權杖）                                                                   |
| run 日誌                    | `DATA/runs/<run_id>/{events.jsonl, stderr.log, prompt.md}`（寫入前遮蔽像金鑰的字串）                                 |
| leader                      | `DATA/leader/`（空的工作目錄、`team` shim、最近一個 turn 的日誌）                                                    |
| 任務 worktree               | `~/RanoLabs/worktrees/<project>/<task_id>/`（`service.json` 的 `paths.worktree_root`）；完成 72 小時後移除，分支保留 |
| 設定                        | `config/service.json`、`config/models.json`（`AGENT_TEAM_CONFIG_DIR` 可改）                                          |
| 秘密                        | 專案根目錄 `.env`                                                                                                    |

## 疑難排解

先跑 `team doctor`：各 runner 是否可用、版本與支援的參數、憑證有沒有就緒（只顯示有無）、資料目錄與資料庫。

| 症狀                                             | 處理                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `agent-team is not running (no …/listener.json)` | 服務沒開：`team serve`；或 `AGENT_TEAM_HOME` 與服務不一致                       |
| `127.0.0.1:4517 is already in use`               | 另一個 agent-team 還在跑，或改 `service.json` 的埠                              |
| 看板 403 `origin … is not allowed`               | 用服務印出的網址開；反向代理或開發伺服器的來源加進 `lan.allowed_origins`        |
| 看板登入 429                                     | 連續輸錯 5 次，鎖 15 分鐘                                                       |
| leader 顯示離線 `auth`                           | `claude` 重新登入後 `team leader reset`                                         |
| leader 顯示離線 `rate_limit`                     | 額度用完，會在顯示的時間自動重試；或換帳號後 `team leader reset`                |
| leader 顯示離線 `not_installed`                  | 找不到 `claude` 或 `apps/cli/dist`：安裝／`pnpm build` 後 `team leader reset`   |
| leader 顯示離線 `disabled`                       | `service.json` 的 `leader.enabled` 是 false                                     |
| 任務 `blocked`，原因 `start_unknown`             | worker 是否已開始工作無法判定，不會自動重送；確認 worktree 後 `team task retry` |
| worktree 標為 `kept`                             | 移除時發現未提交的變更，已保留並開一筆待決事項，請手動處理                      |

## 已知限制

- **持有區網密碼的人就能讓 agent 在這台電腦上執行程式碼**（派工、退回、回答待決事項都能從看板做）。區網密碼等同
  這台電腦上一個受限的 shell，只給信任的人。
- 沙箱擋什麼、不擋什麼（ADR 0014）：claude worker 在 Claude Code 的沙箱內，讀寫只限 worktree（與暫存、套件快取），
  讀不到 DATA（資料庫、含權杖的 listener 檔）、`.env`、`~/.ssh` 等憑證目錄，連不到本機的服務埠；codex worker 用權限
  設定檔拒絕同一份清單；macOS 上機器檢查也以 `sandbox-exec` 套同一份清單（檢查可以起自己的本機測試伺服器，
  但連不到服務的埠）。**不擋**：dsh worker 讀得到清單內的檔案
  （dsh 沒有這種設定）、Linux 上的檢查不在沙箱內、`allow_network` 開啟時 worker 能把 worktree 內容送到公開網站、
  worker 讀得到主 repo 的 `.git/config`。listener 檔只靠 0600 權限保護：同一個使用者、不在沙箱內的行程（leader 的
  claude、你自己的工具）都讀得到 operator 權杖。
- 只有人能驗收、退回、回答待決事項、改派與建專案；leader 用自己的權杖，伺服器依權杖判定身分（ADR 0014）。
- 服務端代提交時不執行 repo 的 git hooks（ADR 0016）；要在提交前檢查的事請寫進專案的 `checks`。
- 不自動合併分支回主幹；不做提交前的檔案租約、自動輪換帳號、Jev 判定關卡、TLS、多使用者（spec §16）。
- 區網是未加密的 HTTP；需要 TLS 請自行加反向代理。
- leader 的 shell 範圍用 allow／deny 清單收斂，但 Claude Code 沒有「只允許這些」的 Bash 規則，清單以外的唯讀指令仍
  可能被它自動核准（只看得到空的工作目錄與不含秘密的環境；見 ADR 0012）。
- 一個 leader turn 最長 10 分鐘；`team ask`／MCP 會一直等，但呼叫端自己的逾時（例如某些 MCP 用戶端）仍可能先放棄，
  訊息不會遺失，回覆之後出現在看板聊天。
- 強制結束（第二次 Ctrl-C、kill -9、當機）時 leader 當下的 `claude` 行程可能殘留；worker 的行程群組會在強制結束前
  被 SIGKILL；當機時由下次啟動的復原先終止殘留的 worker 群組（pid 與啟動時間都相符才終止），無法確認的任務會阻塞
  等人處理，不會派第二個 worker 進同一個 worktree（ADR 0015）。
- 看板與 Grok 主動通知是單一使用者設計；沒有帳號與權限分級。

## 開發

```sh
HUSKY=0 pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm check:boundaries && pnpm check:generated
pnpm test:e2e          # Playwright 看板冒煙
```

測試只用暫存目錄與 127.0.0.1，不碰 `~/.agent-team`、`~/RanoLabs`，不呼叫真實模型（冒煙測試要 `TEAM_SMOKE=1`）。
