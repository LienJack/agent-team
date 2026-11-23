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

| 變數                                     | 用途                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `OPENROUTER_API_KEY`                     | dsh worker 與 `hub_summarizer`（經 OpenRouter）；留在服務端的金鑰代理，dsh 只拿到 run 權杖 |
| `JEV_API_KEY`、`JEV_URL`、`JEV_PROVIDER` | Jev 判定關卡（預設關閉，v1 不用）                                                          |

秘密不會進資料庫、日誌、API 回應、worker 的派工單或任何子行程的環境。`team doctor` 只顯示「有／沒有」，不顯示值。

**秘密只放在 `.env`，不要 `export` 到啟動服務的 shell。** 同一個使用者的任何行程都讀得到另一個行程啟動時的環境
（`sysctl KERN_PROCARGS2`，Seatbelt 也擋不住）：服務啟動時若在自己的行程環境裡看到 `OPENROUTER_API_KEY`、
`JEV_API_KEY`，會對每一個記一條 `secret in the process environment` 警告（只寫名稱）。事後清掉
`process.env` 沒有用——被讀的是啟動時的那份。dsh 同理拿不到真金鑰：服務端在 `127.0.0.1` 的臨時埠跑一個金鑰代理，
每個 dsh run 只拿到一個 run 結束就撤銷的權杖（ADR 0020）。

## 啟動

```sh
pnpm start        # 需要時先建置，再從 dist 啟動（前景執行）
# 或（已建置過）
team serve
```

啟動時會印出：

```
看板（這台電腦）：http://127.0.0.1:4518
區網看板：http://192.168.x.y:4518
注意：區網看板沒有任何驗證、來源或主機檢查。…（lan.host 不是 127.0.0.1 時才印）
```

Ctrl-C 正常關機：執行中的 worker 整個行程群組會被終止，它們的 run 標為 `abandoned`、任務重新排入並附上復原說明，
下次啟動接著做（再按一次 Ctrl-C 會強制結束）。

### 打開看板

- **這台 Mac**：瀏覽器開 `http://127.0.0.1:4518`，不需登入。
- **區網內的其他裝置**：開 `http://<這台 Mac 的區網 IP>:4518`（上面印出的「區網看板」網址），不需登入。

> **警告：區網看板沒有任何驗證（沒有密碼），也不檢查來源（`Origin`）或主機（`Host`）**（擁有者 2026-11-22 的決定，ADR 0024）。同一個網路上的任何人
> 都能打開看板、派工、驗收、回答待決事項、建專案，而任務與專案的機器檢查會**在這台 Mac 上執行程式碼**。不只區網裝置：
> 網路上任何一台電腦的瀏覽器裡開著的任何網頁，也可能透過那個瀏覽器操作看板（跨站請求、DNS rebinding）。
> 區網是未加密的 HTTP。要限制，只有兩個開關（`config/service.json`）：
>
> - `"lan": { "enabled": false }`：關掉看板，只剩 CLI／MCP（本機監聽埠，照常要權杖）。
> - `"lan": { "host": "127.0.0.1" }`：只有這台 Mac 連得到看板；但這台 Mac 上的其他使用者、程式與瀏覽器裡的網頁
>   仍然可以操作它。

看板只在區網監聽埠（預設 `0.0.0.0:4518`）提供；本機監聽埠 `127.0.0.1:4517` 只給 CLI／MCP，用 `listener.json`
裡的權杖，不提供頁面。區網上能做的事與本機 CLI 相同（包括建專案與 `leader reset`；看板本身沒有建專案的畫面，
用 CLI 或 `POST /api/projects`）。

### 截圖

2026-11-21 真實 agent 驗證時的看板（[`docs/validation-2026-11-21.md`](docs/validation-2026-11-21.md)），五欄都有任務：

| 桌面                                                                                     | 手機                                                                 |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| ![看板（淺色）](docs/screenshots/board-desktop-light.png)                                | ![看板（手機、淺色）](docs/screenshots/board-phone-light.png)        |
| ![看板（深色）](docs/screenshots/board-desktop-dark.png)                                 | ![看板（手機、深色）](docs/screenshots/board-phone-dark.png)         |
| ![寬螢幕：側欄待決事項](docs/screenshots/board-wide-light.png)                           | ![卡片抽屜（手機）](docs/screenshots/drawer-phone-light.png)         |
| ![卡片抽屜：阻塞原因、修正單、派工單](docs/screenshots/drawer-desktop-light.png)         | ![待決事項（手機、深色）](docs/screenshots/attention-phone-dark.png) |
| ![卡片抽屜：審查發現與 run 清單](docs/screenshots/drawer-desktop-dark-findings-runs.png) | ![與 leader 對話（手機）](docs/screenshots/chat-phone-light.png)     |
| ![卡片抽屜：日誌尾段](docs/screenshots/drawer-desktop-dark-log.png)                      | ![與 leader 對話（深色）](docs/screenshots/chat-desktop-dark.png)    |

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

team status            # 看板摘要（report: 一行，五欄計數加總等於總數）
team watch             # 即時事件（Ctrl-C 結束）
team receipt <task_id> # 最新回執
```

`team task add|queue|cancel|retry` 與 `team research add` 會多印兩行：`delivery:`（`running`／`queued` 與等待原因／
`draft`／`done`／`not_accepted` 與原因）與 `report:`（程式產生的一句繁中）。回覆前服務端先跑一次排程，所以排得進去的
任務回來時已是 `running`；被拒或連不上時也印 `not_accepted`。leader 回報任務狀況時轉述這一行（ADR 0022）。

或者直接跟 leader 說：`team ask "幫 demo 的登入頁加上記住我，拆成派工單"`。

任務的流程：`draft → queued → running → verifying → review → done`（旁支 `blocked`、`failed`、`cancelled`）。
worktree 在 `~/RanoLabs/worktrees/<project>/<task_id>/`，分支 `team/<task_id>`；分支永遠保留，不會自動合併回主幹。

## 調研（可選）

規劃前先查有沒有可參考的開源專案（spec §17、ADR 0021）。調研是一種任務，不是每張單都跑的步驟：

```sh
# 建調研任務並排入（題目也可用 --question-file F 或 - 從 stdin）
team research add demo --title "調研：SQLite 工作佇列" --queue \
  --question "有哪些以 SQLite 為後端的 TypeScript 持久化工作佇列函式庫？"

team research show <task_id>     # 建議、摘要、候選（名稱、連結、授權、適合度）

# 實作單引用已完成的調研（可重複，最多 3 個、同專案）：回執會附在實作、修正、審查的提示裡
team task add --project demo --title "加入工作佇列" --tier B --paths "src/queue/" \
  --research <調研任務 id> --queue - <<'EOF'
…
EOF
```

- 調研 run 讀的是不可信的網頁，所以**拿不到專案**：工作目錄是空的 `DATA/research/<run_id>/`（run 結束即刪），沒有檔案或
  shell 工具，只有網頁搜尋與抓取；提示只有題目。結果是一份有長度上限的回執，連結只檢查是 `https:` 且不含帳密，服務端
  **不會**去連，看板與 CLI 都標「連結未經服務端驗證」。
- 授權不是寬鬆授權（MIT、Apache-2.0、BSD、ISC）或不明的候選，worker 只能參考做法、不可複製程式碼（提示裡的規則）。
- 角色 `oss_researcher`（預設 `sonnet`，替補 `gpt-sol`、`haiku`）。只有 probe 宣告 `webSearch` 的 runner 能跑：claude
  （`--tools WebSearch,WebFetch`）、codex（`web_search="live"`、關掉 shell 等工具功能、拒讀整個檔案系統；實測仍會提供
  `apply_patch` 與 collaboration 工具，見 ADR 0021）；dsh 不行（它的搜尋要
  `DEEPSEEK_API_KEY` 進 worker），別名是 dsh 就跳過，全都不行時任務阻塞並說明。`team doctor --json` 看 `supports.webSearch`。
- `config/service.json` 的 `research.mode`：`off`（調研入口與 `--research` 回 409）、`on_request`（預設：人要求才跑）、
  `auto`（leader 遇到新子系統、選函式庫、協定或演算法設計時先調研）；`research.timeout_ms` 預設 10 分鐘。改了 mode，
  leader 下次啟動會開新對話（系統提示帶入對應的一句）。
- 看板：新增任務時可選「調研」；新增實作任務時可勾選同專案已完成的調研；抽屜顯示候選清單。MCP：`add_research`、
  `show_research`。

## 專案記憶（可選，MemOS）

跨任務的記憶，以專案為單位，存在綠聯 NAS 上既有的 MemOS（`http://greennas.local:8000`；spec §18、ADR 0023）。**預設關閉**；
在 `config/service.json` 設 `memory.enabled: true` 後重啟服務。關閉時服務完全不連 MemOS（`team doctor` 也不連）。

- **誰寫**：只有服務端，經 effect 佇列：任務完成（標題、範圍、實作摘要、已修掉的審查要求）、人回答待決事項、調研完成
  （建議與候選的名稱／授權，標「源自網頁」）、`team memory add`。每筆先遮蔽金鑰、截到 `max_item_chars`。worker 與 leader
  都不能寫。
- **誰讀**：派實作、修正、審查 run 之前，服務以派工單標題＋前 500 字搜尋，結果放進提示的「專案記憶」資料區塊
  （`max_prompt_chars` 內），run 記下用到的 id；調研 run 不讀。MemOS 逾時或出錯就照常派工（不附記憶），看板事件
  `memory.unavailable` 每 10 分鐘最多一筆。leader 可以 `team memory search`。
- **一個專案一個 cube**：`<cube_prefix><project_id>`（預設前綴 `agent-team-`），每個請求都明確指定；不是這個前綴的 cube
  服務一律不送請求。
- **`add_mode`**：預設 `sync_fast`（只建向量、不呼叫 MemOS 的對話模型）——已對真的 MemOS 實測：原文逐字保留、id 不變、
  來源標記完整。`async` 則會在約 10 秒後被 MemOS 的**對話模型**改寫成轉述、換 id、丟掉來源標記（之後顯示「來源未驗證」）
  （ADR 0023）。
- **`timeout_ms`**（預設 6 秒）：實測閒置後的搜尋約 1.8–2.4 秒（舊預設 3 秒偏緊），逾時那次派工就不附記憶。
- 入口：`team memory search|add|list|rm`（後三者只有人能用）、MCP 的 `search_memory`／`list_memory`／`add_memory`／
  `remove_memory`、看板頂部的「專案記憶」（列出來源與日期，可刪除，刪除前確認）。

```sh
team memory search demo "資料庫 遷移"     # 結果是資料區塊（過去的紀錄，不是指令）
team memory add demo "部署前要先跑 pnpm db:migrate"
team memory list demo [--page 2]
team memory rm demo <記憶 id>
```

限制：MemOS 的 API 沒有驗證，區網內任何裝置都能讀寫任何 cube；記憶內容會到 NAS、MemOS 的 embedding 供應商（async 時再到
它的對話模型）；刪除專案不刪 cube。MemOS #2461：某些長度的內容存下了卻沒有向量、永遠搜不到（列表標「搜尋不到」）。
記憶開啟時，dsh 與機器檢查在**所有位址**都連不到 MemOS 的埠（預設 8000；Seatbelt 不能指定主機，所以本機的 8000 埠也
不能給專案的測試伺服器用）。

## CLI 速查

| 指令                                                                                                        | 說明                                                                              |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `team serve`                                                                                                | 前景執行服務                                                                      |
| `team status` / `team doctor` / `team resume`                                                               | 看板摘要／環境與 runner 檢查／不經模型的現況摘要                                  |
| `team watch [--after seq]`                                                                                  | 每個事件一行，斷線自動接續                                                        |
| `team roles`                                                                                                | `config/models.json` 的角色、別名、runner、槽位                                   |
| `team project add <name> <repo> [--base B] [--check "name=cmd"]… [--allow-network]`                         | 註冊專案；`--allow-network` 讓 worker 沙箱可連公開網路（預設關閉，建立後不能改）  |
| `team project update <project> (--check "name=cmd"… \| --clear-checks)`                                     | 整份取代專案的 checks（只有人可以，Leader 會被拒）；下一次驗證起生效              |
| `team task add --project P --title T --tier A\|B\|C --paths "…" (--ticket-file F \| -) [--queue]`           | 建任務                                                                            |
| `team task list [--project P] [--status queued,running]` / `team task show <id>`                            | 列出／詳情                                                                        |
| `team task queue\|cancel\|retry <id>`                                                                       | 排入／停止並取消／重試                                                            |
| `team task reassign <id> <role>`                                                                            | 改派角色（先檢查角色存在且啟用）                                                  |
| `team task add … --research <task_id>`                                                                      | 引用已完成的調研（可重複，最多 3 個）                                             |
| `team research add <project> --title T (--question Q \| --question-file F \| -) [--queue]`                  | 建調研任務（`research.mode` 為 `off` 時 409）                                     |
| `team research show <task_id>`                                                                              | 調研結果（連結未經服務端驗證）                                                    |
| `team receipt <task_id>`                                                                                    | 最新回執                                                                          |
| `team ask "<text>"`                                                                                         | 對 leader 說話，等到回覆為止；Ctrl-C 只停止等待（訊息保留，回覆會出現在看板聊天） |
| `team leader reset`                                                                                         | 開新的 leader 對話（例如換了 Claude 登入）                                        |
| `team attention list` / `open --question Q --option A …` / `answer <id> "<答案>"`                           | 待決事項；回答 worker 提出的最後一個問題後，任務帶著回答自動續行（ADR 0017）      |
| `team memory search <project> <query>` / `add <project> <text\|->` / `list <project>` / `rm <project> <id>` | 專案記憶（spec §18；關閉時 409）；leader 只能 search                              |

每個指令都可加 `--json`。結束碼：0 成功、1 業務錯誤、2 用法或連線錯誤（`team ask` 被 Ctrl-C 中止是 130）。

## Claude skill：`/team-agent`

`skills/team-agent/` 是給 Claude Code 的 skill：在任何 session 輸入 `/team-agent`（或說「交給 agent team」）就會確認服務
已啟動（沒開就在背景啟動）、打開看板，之後用 `team` 指令把你的需求轉給 leader、回報進度；它不讀 worker 的日誌，也不
替你做決定。安裝（連結到本 repo，更新 repo 即更新 skill）：

```sh
ln -s /ABS/PATH/agent-team/skills/team-agent ~/.claude/skills/team-agent
```

## MCP（Claude／Codex 桌面版）

工具：`ask_leader`、`status`、`list_attention`、`answer_attention`、`task_action`、`add_research`、
`show_research`、`search_memory`、`list_memory`、`add_memory`、`remove_memory`（細節見
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

## 實測成本參考

2026-11-21 用真實 runner 跑的小型派工單（一兩個檔案、`node --test`；細節與全部數字見
[`docs/validation-2026-11-21.md`](docs/validation-2026-11-21.md)）。claude 的費用是 CLI 回報的 API 等價金額（走訂閱）；
codex（訂閱）與 dsh（OpenRouter 按量）不回報費用：服務端依 token 用量 × `models.json` 牌價存一個**估算值**
（未快取的輸入與 cache 寫入用輸入價、cache 讀取用輸入價的 10%、輸出用輸出價），run 上標 `cost_estimated`，看板顯示
「≈$0.01 估算」、`team task show` 顯示「~$0.0005 (estimated)」。它不是帳單：dsh 的實際費用看 OpenRouter。下表
2026-11-21 第一輪的估算是區間（cache 讀取以輸入價的 10%–100% 計）。

| 組合                                      | 牆鐘         | 實作 run                                                       | 審查 run                                                   |
| ----------------------------------------- | ------------ | -------------------------------------------------------------- | ---------------------------------------------------------- |
| C 級：deepseek-flash 實作、gpt-terra 審查 | 20–45 s      | 8–18 s，約 10k 輸入／40–70k cache／1k 輸出，≈ $0.001–0.004     | 10–15 s，約 6–16k 輸入、100–400 輸出，≈ $0.01–0.02（訂閱） |
| B 級：gpt-terra 實作、haiku 審查          | 35 s         | 26 s，16k／31k／0.6k，≈ $0.02–0.05（訂閱）                     | 8 s，$0.0016                                               |
| A 級：sonnet 實作、gpt-terra 審查         | 21 s         | 9 s，$0.067                                                    | 12 s，≈ $0.02（訂閱）                                      |
| 一輪審查退回再修正（C 級）                | 再加 25–50 s | 修正 run 與實作 run 相近                                       |                                                            |
| leader turn（haiku）                      | 3–10 s       | 每 turn $0.001–0.015；15 秒內接連完成／阻塞的單合併成一個 turn |                                                            |

最壞的一次：deepseek 在一個 8 函式的修正輪跑了 252 秒、讀了 6.3M cache token（≈ $0.05–0.33）。整個驗證（19 張單、
60 個 run、24 個 leader turn）真正付費的 dsh 部分約 $0.09–0.50。

## Grok 橋接

預設關閉。開啟前**先停掉現有的中樞 session（「Grok bot 中樞整理」）**：兩者監看同一個 `grokmsg` 收件匣，同時開會
重複處理、重複回覆。

1. 確認 `grokmsg` 在 PATH 上。
2. `config/service.json` 設 `"grok": { "enabled": true }`（可另設合併視窗、安靜時段、整理門檻）。
3. 重新啟動服務。

開啟後：Grok 來的訊息原文交給 leader；回覆、待決事項（問題與選項原樣）與主動通知（完成、失敗、阻塞、
額度用完、熔斷）先寫 outbox 再送，相同特徵不會重發（重啟後亦然）。選項按鈕只在全部只有一筆待決事項、它不是高風險
（重建 worktree、`start_unknown` 後重試、worker 可能還活著時重試、worktree 身分不符、保留的 worktree）、問題與選項
都放得下（`grok.buttons`）時才帶；否則訊息指向看板或 CLI，從 Grok 回的選擇不會被記錄、會回一句原因（ADR 0022）。

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

| 內容                        | 位置                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 資料目錄 `DATA`             | `~/.agent-team/`（`AGENT_TEAM_HOME` 可改）                                                                                        |
| 資料庫                      | `DATA/team.db`（SQLite，WAL）                                                                                                     |
| 連線資訊（CLI／MCP 自動讀） | `DATA/run/listener.json`（0600，每次啟動換新權杖）；DATA 本身 0700                                                                |
| run 日誌                    | `DATA/runs/<run_id>/{events.jsonl, stderr.log, prompt.md}`（寫入前遮蔽像金鑰的字串）                                              |
| leader                      | `DATA/leader/`（空的工作目錄、`team` shim、leader 權杖的 listener 檔、`api.sock`、目前 turn 的 `turn-key`、最近一個 turn 的日誌） |
| 任務 worktree               | `~/RanoLabs/worktrees/<project>/<task_id>/`（`service.json` 的 `paths.worktree_root`）；完成 72 小時後移除，分支保留              |
| 設定                        | `config/service.json`、`config/models.json`（`AGENT_TEAM_CONFIG_DIR` 可改）                                                       |
| 秘密                        | 專案根目錄 `.env`                                                                                                                 |

## 疑難排解

先跑 `team doctor`：各 runner 是否可用、版本與支援的參數、憑證有沒有就緒（只顯示有無）、資料目錄與資料庫。

| 症狀                                             | 處理                                                                                                                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-team is not running (no …/listener.json)` | 服務沒開：`team serve`；或 `AGENT_TEAM_HOME` 與服務不一致                                                                                                                                           |
| `127.0.0.1:4517 is already in use`               | 另一個 agent-team 還在跑，或改 `service.json` 的埠                                                                                                                                                  |
| 啟動失敗 `lan: Unrecognized keys: …`             | `service.json` 還留著已移除的區網密碼／來源設定（`lockout_failures`、`lockout_minutes`、`session_hours`、`allowed_origins`）：刪掉這幾個鍵（ADR 0024）                                              |
| leader 顯示離線 `auth`                           | `claude` 重新登入後 `team leader reset`                                                                                                                                                             |
| leader 顯示離線 `rate_limit`                     | 額度用完，會在顯示的時間自動重試；或換帳號後 `team leader reset`                                                                                                                                    |
| leader 顯示離線 `not_installed`                  | 找不到 `claude` 或 `apps/cli/dist`：安裝／`pnpm build` 後 `team leader reset`                                                                                                                       |
| leader 顯示離線 `disabled`                       | `service.json` 的 `leader.enabled` 是 false                                                                                                                                                         |
| 任務 `blocked`，原因 `start_unknown`             | worker 是否已開始工作無法判定，不會自動重送；確認 worktree 後 `team task retry`                                                                                                                     |
| worktree 標為 `kept`                             | 移除時發現未提交的變更（或沒通過身分檢查），已保留並開一筆待決事項，請手動處理                                                                                                                      |
| 任務 `blocked`，原因 `worktree_integrity:`       | worktree 的 `.git` 被改寫（ADR 0018），服務端拒絕在其中執行 git、沒有提交；檢查後由人選「重建 worktree」（刪掉重建，不跟隨被改的指標），或在主 repo 執行**不帶路徑**的 `git worktree repair` 再重試 |
| 任務 `blocked`，原因「機器檢查沒有執行」         | 這台電腦沒有 `sandbox-exec`（Linux）：檢查不在沙箱外執行；確定要跑就設 `checks.allow_unsandboxed: true`（ADR 0019）                                                                                 |
| `team doctor` 顯示 dsh 不可用（sandbox-exec）    | dsh 只在 Seatbelt 內執行；Linux 上要明確設 `runners.dsh.allow_unsandboxed: true`（ADR 0019）                                                                                                        |
| leader 顯示離線 `not_installed`（socket path）   | `AGENT_TEAM_HOME` 太長，`DATA/leader/api.sock` 超過 unix socket 的 103 位元組：改用較短的路徑                                                                                                       |
| 卡片顯示「等待：…」                              | 排隊的任務為什麼還沒派出（路徑重疊、沒有槽位、runner 冷卻、退避、基底漂移）；事件 `task.waiting`                                                                                                    |
| runner 一直熔斷、有一筆「停止自動恢復」的事項    | 連續 3 次冷卻結束後的第一個 run 又撞到額度上限（ADR 0022）：確認額度恢復後回答「重新啟用」，或人重試一個用到它的任務                                                                                |

## 已知限制

- **區網監聽埠沒有驗證、來源檢查或主機檢查**（ADR 0024）：同一網路上的任何裝置，以及網路上任何瀏覽器裡開著的網頁，
  都能讓 agent 在這台電腦上執行程式碼（派工、驗收、建帶任意 `checks` 的專案都能從區網做）。這等同把這台電腦上一個
  受沙箱限制的 shell 開給整個網路。只在完全信任的網路開著，否則設 `lan.enabled: false` 或 `lan.host: "127.0.0.1"`。
  worker 與機器檢查的沙箱拒連服務自己的埠，現在是它們與「人」的權限之間唯一的屏障（claude worker 連這台電腦的區網 IP
  沒有實測，ADR 0014）。
- 沙箱擋什麼（ADR 0014、0018、0019、0020）：三家 worker 讀寫只限 worktree（與暫存、套件快取），讀不到 DATA（資料庫、含權杖
  的 listener 檔）、`.env`、`~/.ssh` 等憑證目錄，也不能改寫 worktree 的 `.git` 指標檔：claude worker 在 Claude Code 的
  沙箱內（連不到任何本機埠）、codex 用權限設定檔、dsh 整個行程在 macOS Seatbelt（`sandbox-exec`）內（服務自己的埠在
  任何位址都連不到）。服務端在 worktree 裡的每一個 git 指令之前都先核對 worktree 的身分，`.git` 被改寫就拒絕、不提交、
  阻塞並開待決事項。macOS 上機器檢查也在 Seatbelt 內（可起自己的本機測試伺服器，連不到服務的埠）。dsh 與機器檢查
  都不能對沙箱外的行程送訊號，也連不到家目錄（worktree 除外）、DATA（leader 的 API socket）、ssh-agent、Docker／
  OrbStack 與 tmux 的 unix socket；dsh 在 `~/.dsh` 只讀得到 `profiles/headless`。沒有
  `sandbox-exec` 的平台（Linux）上，檢查與 dsh **預設不執行**，要明確設 `checks.allow_unsandboxed`／
  `runners.dsh.allow_unsandboxed` 才會不經沙箱執行。leader 的 Bash 也在 Claude Code 的沙箱內，只開放 `team` shim 需要
  的檔案與一個 unix socket（ADR 0012）。
- **不擋**：`allow_network` 開啟時 worker 能把 worktree 內容送到公開網站；dsh 的網路沒有網域白名單（Seatbelt 只能寫
  `localhost` 或 `*`），只擋服務的埠；dsh run 進行中，同一使用者的其他行程讀得到該 run 的權杖、在 run 結束前可經金鑰
  代理花用額度（但拿不到金鑰本身，ADR 0020）；金鑰代理直接連 OpenRouter，不經環境裡的 `HTTPS_PROXY`；worker 讀得到主 repo 的 `.git/config`（遠端網址若含權杖會外洩）；dsh 在沙箱內
  每次啟動都會改寫自己設定檔裡的空白根設定（`~/.dsh/profiles/headless/cordis.yml`，內容由 dsh 重設）。listener 檔只靠
  0600 權限保護：同一個使用者、**不在任何沙箱內**的行程（你自己的工具，以及 leader 的 claude 行程本身——沙箱套在它執行
  的 Bash 上）都讀得到 operator 權杖。Linux 上的 Claude Code 沙箱（bubblewrap）沒有在本機驗證過，且 Claude Code 在
  Linux 上不支援以路徑限定 unix socket（leader 的 `team` 因此連不到服務）。
- 只有人能驗收、退回、回答待決事項、改派與建專案；leader 用自己的權杖，伺服器依權杖判定身分（ADR 0014）。區網監聽埠
  上的每個請求都算「人」。
- 服務端代提交時不執行 repo 的 git hooks（ADR 0016）；要在提交前檢查的事請寫進專案的 `checks`。
- 不自動合併分支回主幹；不做提交前的檔案租約、自動輪換帳號、Jev 判定關卡、TLS、多使用者（spec §16）。
- 區網是未加密的 HTTP；需要 TLS 請自行加反向代理。
- leader 的 shell 範圍用 allow／deny 清單收斂，但 Claude Code 沒有「只允許這些」的 Bash 規則，清單以外的唯讀指令仍
  可能被它自動核准；那些指令在沙箱內，讀不到 DATA 與憑證目錄，也沒有網路（見 ADR 0012）。
- 一個 leader turn 最長 10 分鐘；`team ask`／MCP 會一直等，但呼叫端自己的逾時（例如某些 MCP 用戶端）仍可能先放棄，
  訊息不會遺失，回覆之後出現在看板聊天。
- 強制結束（第二次 Ctrl-C、kill -9、當機）時 leader 當下的 `claude` 行程可能殘留；worker 的行程群組會在強制結束前
  被 SIGKILL；當機時由下次啟動的復原先終止殘留的 worker 群組（pid 與啟動時間都相符才終止），無法確認的任務會阻塞
  等人處理，不會派第二個 worker 進同一個 worktree（ADR 0015）。離開群組的後代（`setsid`、daemon）在 run 結束或復原時
  一併終止，但只限有擁有權證明的（工作目錄或命令列含該 run 的 worktree／日誌目錄、父行程已不在、沒有終端、run 期間
  啟動）；自己 `chdir("/")` 又不在命令列留路徑的 daemon 無法歸屬、會存活（ADR 0022）。實測（2026-11-21）：服務被 `kill -9` 後，真實的 dsh
  worker 1.5 秒內就自己結束了（推測是管線中斷），被中斷的 codex 審查在重啟前也已不在；復原兩次都走「行程已不在 →
  重新排入」，「終止殘留群組」那一支只有照劇本的假 claude 測過。
- leader 的 turn 若在當機前已執行過指令，重啟後同一則輸入會再跑一次：提示會說明「可能已經做過」，`team task add`
  完全相同的請求由伺服器去重（Idempotency-Key 由訊息 id 與內容推導）；內容稍有不同的重複建立仍要靠 leader 先查
  `team task list`（ADR 0012）。
- codex 與 dsh 的費用是**估算**（token 用量 × 牌價，cache 讀取以 10% 計），不是帳單。
- `AGENT_TEAM_HOME` 不要太長：`DATA/leader/api.sock` 必須在 103 位元組內，否則 leader 不可用；socket 因任何原因綁不起來
  時 leader 也標為不可用（`not_installed`，提示寫原因），訊息照常保存，修好後重啟服務。
- 看板與 Grok 主動通知是單一使用者設計；沒有帳號與權限分級。

## 開發

```sh
HUSKY=0 pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm check:boundaries && pnpm check:generated
pnpm test:e2e          # Playwright 看板冒煙
```

測試只用暫存目錄與 127.0.0.1，不碰 `~/.agent-team`、`~/RanoLabs`，不呼叫真實模型（冒煙測試要 `TEAM_SMOKE=1`）。
