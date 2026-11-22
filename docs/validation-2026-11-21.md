# 真實 agent 端到端驗證（2026-11-21）

第一次用**真實 runner**（claude 2.1.326、codex 0.171.0、dsh 0.2.1-rc.5）把整條流程跑完：建專案 → 派工 → worker 實作 →
服務端對照 git 與機器檢查核對 → 服務端代為 commit → 跨廠商審查 → 完成。發現的缺陷都先寫失敗的測試再修，修完重跑該情境。

## 環境

- 隔離：`AGENT_TEAM_HOME`、設定副本、worktree 根目錄與 11 個暫存目標 repo 全在 `~/.cache/ranolabs/sessions/2026-11-21-agent-team-e2e/`（結束後已刪除）；
  兩個監聽埠都只綁 `127.0.0.1`（64724／64725），Grok 關閉，leader 開啟；看板密碼由 process env 給一組一次性值（不碰 `.env`）。
- 目標 repo：純 Node（`src/*.js` + `node --test`），專案檢查 `test=node --test`；每個情境一個 repo，基底各自獨立。
- 設定副本只用便宜的模型（repo 的 `config/models.json` 未改）：

| 角色                         | 別名（runner）                                                          | 備註                           |
| ---------------------------- | ----------------------------------------------------------------------- | ------------------------------ |
| leader                       | haiku（claude）                                                         |                                |
| impl_A／impl_B／impl_C       | sonnet（claude）／gpt-terra（codex，effort low）／deepseek-flash（dsh） |                                |
| review_A／review_B／review_C | gpt-terra／haiku／gpt-terra                                             | fallback 只用 haiku／gpt-terra |

大模型（opus、fable、gpt-astra、gpt-sol、kimi…）從副本的 `models` 移除，`rules.quota` 也只指向便宜別名。

- 費用：claude 的 `cost_usd` 是 CLI 回報的 API 等價金額（走訂閱，不另外計費）；codex（訂閱）與 dsh（OpenRouter，按量）
  不回報費用，下表的「估算」依 `models.json` 牌價（gpt-terra 1／5、deepseek-flash 0.05／0.2 美元每百萬 token），
  區間的下限把 cache 讀取算成輸入價的 10%，上限算全價。第二輪起服務端自己存估算值（cache 讀取以 10% 計），標
  `cost_estimated`，看板與 `team task show` 都標「估算」（見文末第二輪）。

## 各情境結果

| #   | 情境                           | 結果                    | 牆鐘                                                                    | run（模型：秒、輸入／cache 讀／輸出 token、費用）                         | 修正輪   |
| --- | ------------------------------ | ----------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| 1   | C 級 dsh，codex 審查           | 通過                    | 20 s                                                                    | deepseek 8 s 9.8k／37.6k／1.0k；gpt-terra 審 12 s 15.7k／0／109           | 0        |
| 2   | B 級 codex，claude 審查        | 通過                    | 35 s                                                                    | gpt-terra 26 s 16.3k／31.1k／587；haiku 審 8 s 4.4k／14.3k／1.2k，$0.0016 | 0        |
| 3   | A 級 claude sonnet，codex 審查 | 通過                    | 21 s                                                                    | sonnet 9 s 13.9k／26.5k／870，$0.067；gpt-terra 審 12 s 16.0k／0／99      | 0        |
| 4   | 越界拒收（真實模型）           | 通過（第二次設計）      | 1.3 min（到第一次阻塞）；6.8 min（含驗證 403 時 leader 權杖的一次重試） | 見下                                                                      | 1 + 升級 |
| 5   | 審查 `needs_changes`           | 通過                    | 78 s                                                                    | deepseek 14 s → gpt-terra 審（must_fix 1）→ deepseek 修 38 s → 審查通過   | 1        |
| 6   | 並行 + 路徑重疊                | 通過                    | 44 s                                                                    | 3 張 C 級，各 deepseek 8–18 s + gpt-terra 審 10 s                         | 0        |
| 7   | leader 拆單派工                | 通過（單張，見下）      | 9 s 回覆；任務 24 s                                                     | leader haiku $0.0091；deepseek 12 s + gpt-terra 審 11 s                   | 0        |
| 8   | 待決事項                       | 先失敗，修正後通過      | 25 s（回答後）                                                          | deepseek 修 10.5 s（不改檔）+ gpt-terra 審 14 s                           | —        |
| 9   | 當機復原（dsh）                | 通過，但見下方限制      | kill 11:29:35 → 重啟 11:29:54 → 新 run 11:29:56 → 實作完成 11:30:23     | 見下                                                                      | —        |
| 10  | 額度顯示                       | 先失敗，修正後通過      | —                                                                       | —                                                                         | —        |
| 11  | 看板截圖                       | 通過，修了 3 個視覺缺陷 | —                                                                       | —                                                                         | —        |
| 12  | MCP 對真實服務                 | 通過                    | `status` 0.16 s；`ask_leader` 4.9 s                                     | leader haiku $0.0145                                                      | —        |

### 1–3：三家 runner 各當一次實作者

- **1**：服務端 commit `team(t_…): 修好 sum()…` 只含 `src/sum.js`，作者與 committer 都是設定的服務身分
  `agent-team-e2e <agent-team-e2e@localhost>`；codex 審查者沒用任何工具，只看提示裡的 diff 就回 `pass`。
- **2**：codex 在權限設定檔下可以改 worktree（`file_change` completed），兩個檔案由服務端 commit；審查 run 的
  `prompt.md` 含 `<<<DATA diff#…>>>`，claude 審查者的工具清單是 `Glob Grep Read StructuredOutput`，實際用了 Read ×3。
- **3**：從 `ps` 取得 worker 的 argv：`--safe-mode --restricted --settings {…"sandbox":{"enabled":true,
  "failIfUnavailable":true,"allowUnsandboxedCommands":false…}} --permission-mode dontAsk`；sonnet 在沙箱內用一個 Bash
  寫兩個檔並跑 `node --test`（6/6），服務端的機器檢查（`sandbox-exec`）也通過。

### 4：拒收路徑

第一次設計（派工單要求同時改 `README.md`，owned_paths 只有 `src/greet.js`）**沒有觸發拒收**：deepseek 遵守規則、
不碰 README，回報 `done` + `needs_leader`；審查要求 README → 修正輪改回報 `blocked` 並提問。這條路徑後來成了情境 8。

第二次設計（s4b）：派工單要 worker 改完執行 `node scripts/build.js` 重建有進版控的 `dist/greeting.txt`。

| run                 | 結果                                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deepseek 實作 13 s  | **拒收 `out_of_bounds: dist/greeting.txt`**，機器檢查沒跑，**沒有任何 commit**；修正單內容「下列檔案不在 owned_paths 內，請還原它們的變更：`dist/greeting.txt`」 |
| deepseek 修正 12 s  | 還原 dist、只提交 `src/greet.js`                                                                                                                                 |
| gpt-terra 審查 15 s | `needs_changes`（dist 與原始碼不一致）                                                                                                                           |
| deepseek 修正 11 s  | 又執行 build → 再次 `out_of_bounds`，修正輪達上限，**升級到 impl_B（gpt-terra）**                                                                                |
| gpt-terra 修正 28 s | 回報 `blocked` + 待決事項（派工單本身矛盾），任務停在阻塞（看板截圖用的就是這張）                                                                                |
| gpt-terra 修正 30 s | 驗證 leader 權杖時用 `team-as-leader task retry` 重試了一次（leader 重試預算內允許），同樣回報 `blocked`                                                         |

### 5：審查 `needs_changes`

驗收段落寫的邊界情況（大小寫、空白、`TypeError`）deepseek 第一次就做到了；codex 審查抓到的是敘述裡的
「依 h→m→s 順序」沒被強制（`30m1h` 會被接受），must_fix 1 → 一輪修正 → 通過。

### 6：並行與重疊

`alpha double()`（`src/alpha.js`）與 `beta triple()`（`src/beta.js`）在 11:21:19、11:21:20 同時派出；
`alpha half()`（也是 `src/alpha.js`）一直等到前者 `done`（11:21:43.312）才在 11:21:43.442 派出。等待期間沒有任何事件
說明原因（`path_overlap` 是靜默延後）。

### 7：leader

`team ask "在專案 s7 新增一個函式 isPalindrome…請拆成任務並派工"` 9.3 秒回覆。leader 跑了 `team status --json`、
`team task list` 與一個 `team task add --tier C --paths "src/palindrome.js,src/index.js,test/palindrome.test.js" --queue -`
（派工單含介面、三個案例與「## 驗收標準」）。它判斷一張單就夠，所以任務完成後收到**一則**事件摘要（seq 536）並回覆一句。**多張單合併成一則摘要沒有觀察到**：
只有一張單；情境 6 的三張單完成時間相隔 4 秒與 15 秒，leader 收到三則摘要、各回一次（3 秒視窗，設計如此）。

驗證結束時重新稽核 leader 的整份 Claude 對話紀錄（24 個 turn）：10 個不同的工具呼叫全是 `team …`，沒有讀任何 run 日誌
或對話；每個 turn 的 `denied` 都是 0。用 leader 權杖呼叫
`project add`、`attention answer`、`task reassign`、`leader reset`、`GET /api/runs/:id/log`、`approve`、`reject`、
`POST /api/projects` 全部 403；leader 重試阻塞任務在預算內被允許。全程 24 個 leader turn，haiku 合計 $0.205，
最大上下文 35k token。

### 8：待決事項

修正前：回答兩筆待決事項後 engine 沒有任何動作；leader 收到「已回答」摘要，但它只能說「驗收是你的權限」。人按重試後，
新的修正提示裡沒有回答，worker 又問一次、再度阻塞（中間還有一輪因 dsh 把回執包在 schema 形狀裡而 `invalid_receipt`）。

修正後（ADR 0017）：回答 `a_qmy0thy4jxrn` → 同一交易裡 `blocked→queued（answered (…): queued again with the answer）`
→ 修正 run 的提示含「## 人的回答」→ worker 不改檔回報 `done` → `verified, no new changes` → 審查提示也含回答 →
`pass` → `done`，共 25 秒。

### 9：當機復原（真實 dsh）

第一次嘗試因輪詢腳本的錯誤，`kill -9` 時 dsh 已結束、殺到的是 codex 審查中；復原把審查 run 標為 abandoned、重新審查，
提示附「復原說明」。

第二次：dsh worker（pid 75314，自成群組）執行 4 秒時 `kill -9` 服務。**1.5 秒內 dsh 的群組已經自己消失**（推測是服務端的
管線斷了，dsh 隨之結束；沒有再深入確認原因）；`ps` 沒有任何殘留。重啟後 `recovery.completed`（seq 646）：兩個 run abandoned、兩個任務重新排入、
`terminated_runs: []`（走的是「沒有該行程也沒有該群組 → 重排」分支）；新的 run 在 seq 650 建立（復原之後），提示附
「復原說明」，最後完成。第一次嘗試裡被中斷的 codex 審查，在重啟前也已經不在（沒有量它結束的時間）。所以復原**沒有終止過任何
真實 worker 群組**（`terminated_runs` 兩次都是空的），「終止殘留群組」那一支仍只有 `crash-recovery.test.ts` 的照劇本
claude 驗證；「第一個 worker 還活著時不派第二個」這次只是因為第一個已經不在而成立。

另外：正常關機（SIGTERM）2 秒內結束，執行中的 codex run 標為 abandoned 並重新排入；`team watch` 在重啟後以
「missing or invalid bearer token」結束（缺陷 D6，已修，之後的重啟 watch 都自動接上）。

### 10：額度

真實 claude run 的 `rate_limit_event` 給出 utilization 0.34、重置 2026-11-26T18:00Z；`GET /api/quota`、看板頂部（34%）、
MCP `status` 都有，**`team status` 沒有**（缺陷 D1，已修：`claude ok (34% used, resets 2026-11-26T18:00Z)`）。

### 11：看板

在 127.0.0.1 的區網埠用系統 Chrome（Playwright）登入，五欄都有任務（草稿、執行中、兩到四張待驗收、阻塞與失敗、完成），
桌面 1440×900、寬螢幕 1680×1000、手機 390×844，淺色與深色。要讓任務停在「待驗收」與「失敗」，看板那一輪暫時把
`review_C` 指到與實作者相同的別名（審查者被排除 → 沒有候選，任務停在 review）、`max_attempts: 1`，並加一個指向不存在
模型的 `impl_broken` 角色（dsh 立即回 `UNKNOWN_MODEL` → failed）；截完圖就換回原設定。12 張壓縮後的截圖在
`docs/screenshots/`。服務重啟後看板約 8 秒內回到登入頁（session 金鑰每次啟動重產，設計如此）。

## 缺陷（都已修，括號內是現在涵蓋它的測試）

| #   | 症狀（真實 run）                                                                                          | 修正                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `team status` 不顯示 runner 額度                                                                          | 每個 runner 後附「N% used, resets …」（`apps/cli/src/program.test.ts`「status and doctor summaries」）                                                                                          |
| D2  | 回答 worker 的問題後 engine 不動作，重試的提示裡也沒有回答，worker 重複提問                               | 回答最後一筆就重新排入；之後的提示附問與答（`packages/core/src/engine/answers.test.ts`）                                                                                                        |
| D3  | 回答「不用改」後，不改檔的修正輪被 `no_changes` 拒收                                                      | 已有提交時回到審查、不新增 commit（同上）                                                                                                                                                       |
| D4  | dsh 把回執包成 `{"type":"object","properties":{…}}` → `invalid_receipt`，浪費一輪                         | 取出 `properties`；提示明說不要輸出 schema（`packages/runners/src/dsh/dsh.test.ts`，錄自真實 run 的 `schema-echo.jsonl`）。修正後這種失誤沒有再出現，只有錄下的 fixture 驗證過                  |
| D5  | dsh 回執 `summary` 超過 600 字、漏掉 `needs_leader` → 兩輪 `invalid_receipt`，任務被升級到 codex          | 驗證前正規化（截短、補空值），決定結果的欄位仍嚴格（`packages/schema/src/receipts.test.ts`）。修正後沒有再遇到，只有單元測試                                                                    |
| D6  | 服務重啟後 `team watch` 以 401 結束                                                                       | 事件串流每次重連前重讀 listener.json（`packages/client/src/events.test.ts` 兩條）                                                                                                               |
| D7  | codex worker 的每個 git 指令都警告「unable to access …/.config/git/ignore」（權限設定檔拒讀 `~/.config`） | codex 子行程也帶 `GIT_CONFIG_GLOBAL=/dev/null` 等（`packages/runners/src/codex/codex.test.ts`）。重跑一張 B 級 codex 單：`git status`／`git diff` 結束碼 0，沒有警告也沒有 `missing config key` |

視覺缺陷（截圖看出來的）：

| #   | 症狀                                                                          | 修正                                                                       |
| --- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| V1  | 聊天面板把服務端事件摘要顯示成「我（service）」、放在使用者自己的泡泡         | 標成「服務端事件摘要（交給 leader）」，置中、淡色（`chat-panel.test.tsx`） |
| V2  | 1680 寬（2xl 側欄開啟）時待驗收欄的卡片「用量」逐字斷行、「321.4k tok」被截掉 | 標籤不斷行；欄位寬度不夠時改一欄（`task-card.test.tsx`）                   |
| V3  | 抽屜「日誌尾段（R_4YT5JW3N7Y2A）」把 run id 轉成大寫                          | id 不套用 uppercase（`task-drawer.test.tsx`）                              |

## 用量與費用合計

19 張單、60 個 run（含最後驗證 D7 的一張 B 級單）、24 個 leader turn。

| 模型                          | run 數 | 執行秒數 | 輸入（含 cache 寫） | cache 讀 | 輸出  | 回報費用 | 牌價估算   |
| ----------------------------- | ------ | -------- | ------------------- | -------- | ----- | -------- | ---------- |
| deepseek-flash（dsh，按量）   | 28     | 901      | 450k                | 9.03M    | 121k  | —        | $0.09–0.50 |
| gpt-terra（codex，訂閱）      | 27     | 550      | 265k                | 606k     | 10.2k | —        | $0.38–0.92 |
| haiku（claude worker，訂閱）  | 3      | 44       | 24k                 | 98k      | 7.5k  | $0.0095  |            |
| sonnet（claude worker，訂閱） | 1      | 9        | 14k                 | 26k      | 870   | $0.067   |            |
| haiku（leader，24 turn）      | —      | —        | 32k                 | 720k     | 5.2k  | $0.205   |            |
| broken（故意失敗）            | 1      | 1        | 0                   | 0        | 0     | —        |            |

真正花錢的只有 dsh（OpenRouter），估計 0.09–0.50 美元，其中一半以上來自一次失控的修正輪：deepseek 在 matrix 任務的
第二次修正跑了 252 秒、讀了 6.28M cache token、輸出 46.7k（它最後交了正確的實作）。

## 仍未驗證

- 真實 worker 存活於服務當機之後的情況：dsh 與 codex 都隨服務結束，復原「終止殘留群組」那一支沒有被真實 worker 走到；
  真實 claude worker 在當機時的行為沒測。
- `AGENT_TEAM_HOME` 放在 `~/.cache` 底下（本次就是）時，claude 沙箱的 `allowRead`（含 `~/.cache`）與 DATA 的 `denyRead`
  誰優先：沒有用真實模型去讀 listener 檔驗證（刻意不做）。第二輪讀了 Claude Code 2.1.326 執行檔裡的設定檔產生器：
  落在 allow 內的 deny 會在 allow 之後重新套用（較深的規則優先），所以 DATA 仍拒讀——是讀程式碼，不是實測。
- 多張單接連完成合併成一則摘要：第二輪把摘要改成「靜默視窗」（預設 15 秒內沒有新事件才送，最晚 60 秒、每批最多
  30 則；`event-buffer.test.ts` 三張相隔 4 s、4.5 s 完成 → 一則）；真實多張單的情境沒有重跑。
- 區網從其他裝置連線、Linux、Grok 橋接、`allow_network` 專案：都沒有在這次跑。
- dsh 與 codex 的實際帳單：只有依牌價的估算。

## 第二輪（同日，安全與正確性審查修正後）

同樣的隔離方式（`~/.cache/ranolabs/sessions/2026-11-21-agent-team-round2/`，結束後已刪除；本機監聽埠 `127.0.0.1:0`、
區網關閉、Grok 關閉；設定副本：leader haiku、impl_C deepseek-flash、review_C gpt-terra low）。

| 項目                                | 結果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| leader 沙箱（真實 haiku turn）      | 6.9 s，$0.0024（CLI 回報），輸入 6／cache 讀 23.2k／cache 寫 8.5k／輸出 877。`team status`、heredoc 的 `team task add`（草稿）成功，Claude Code 的對話紀錄把兩者記為 `sandboxed: true`、沒有違規；`/bin/cat DATA/run/listener.json` 被權限層拒絕；`team task add` 帶 `leader:msg:<id>:<hash>` 的 Idempotency-Key                                                                                                                                                                                                                               |
| dsh 沙箱（真實 deepseek-flash run） | 15.9 s，輸入 16.8k／cache 讀 52.4k／輸出 1.2k（估算 ≈ $0.0014）。執行中的 dsh 行程以 `sandbox_check()` 查：listener 檔、`~/.ssh` 拒讀，worktree 的 `.git` 與 `/opt/homebrew/bin/node` 拒寫，worktree 可讀寫；同一份設定檔重放 `cat` listener 與 `~/.dsh/.credentials.yaml` → Operation not permitted，`curl` 服務埠連不上。**發現**：dsh 自己的 bash 沙箱無法巢狀，所有 bash 都失敗（只用檔案工具改好）→ 修正（ADR 0019）                                                                                                                      |
| 端到端（修正後）                    | C 級單 `team task add --queue` 13:20:17 → done 13:20:44（27 s）：deepseek 實作 10 s（2.5k／41.1k／736，≈ $0.0005 估算），在沙箱內跑了 `ls`、`cat`、`node --test`（通過），執行中的行程 listener 檔、`team.db`、`~/.ssh`、`.credentials.yaml` 拒讀、`/opt/homebrew/bin/node` 拒寫；機器檢查 `[sandboxed]` 通過；服務端 commit `team(t_…): 修好 sum()` 只含 `src/sum.js`，作者 `agent-team-e2e`，`main` 不動；gpt-terra 審查 16 s（5.7k／10.0k／97，≈ $0.0071 估算）`pass`。`team task show` 顯示 `~$0.0005 (estimated)`、`~$0.0071 (estimated)` |
| leader 摘要                         | 任務完成後 22 s（15 s 靜默視窗 + turn）一則摘要，haiku $0.0026，沒有執行指令                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 另一個 leader turn                  | 要它跑兩個 `team` 指令：模型用 `echo "---"` 串接 → 整個指令被 deny 清單拒絕（$0.0031）。之後再要一個 turn 時被本機的操作原則擋下，沒有再跑                                                                                                                                                                                                                                                                                                                                                                                                     |

端到端 run 也發現 dsh 的子行程會丟掉名稱含 KEY 的變數，`GIT_CONFIG_KEY_0` 不見、`git status` 失敗；已改用
`GIT_CONFIG_GLOBAL` + 空的 `XDG_CONFIG_HOME`，以離線測試（真實 git、同一份 Seatbelt 設定檔）驗證，沒有再用真實模型跑。

本輪真實模型呼叫：3 個 haiku leader turn（$0.0081）、2 個 deepseek-flash run（估算 ≈ $0.0019）、1 個 gpt-terra 審查
（訂閱，估算 ≈ $0.0071）。

## 第三輪（金鑰代理與 Seatbelt 補強後；ADR 0019 第三輪、0020）

同樣的隔離方式（`~/.cache/ranolabs/sessions/2026-11-21-agent-team-fix3/`，結束後已刪除；worktree 在
`~/RanoLabs/worktrees/fix3-e2e/`，結束後已刪除；本機監聽埠 `127.0.0.1:0`、區網、Grok、leader 關閉；設定副本：impl_C
deepseek-flash（沒有 fallback、不升級）、review_C gpt-terra low、`max_attempts: 1`、`max_fix_rounds_before_escalate: 1`，
所以最多兩個 dsh run）。服務以 `env -i`（只有 PATH、HOME、TMPDIR、LANG、`AGENT_TEAM_*`）從 `dist` 啟動，金鑰由服務自己從
預設的 `.env` 讀（只用 `team doctor` 確認 present，沒有讀檔）；啟動日誌沒有 `secret in the process environment`。

| 項目               | 結果                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C 級單（真實 dsh） | `team task add --queue` → `done` 23 s：deepseek-flash 實作 9.0 s（輸入 7.8k／cache 讀 28.7k／輸出 708，估算 ≈ $0.0007），在新設定檔內跑了 `ls`、`cat`、`node --test`（pass 1、fail 0），工具結果沒有任何 `Operation not permitted`；服務端 commit `team(t_…): 修好 sum()` 只含 `src/sum.js`，作者 `agent-team-e2e`，`main` 不動；gpt-terra 審查 13.2 s（15.6k／0／102，估算 ≈ $0.016）`pass` |
| dsh 行程的環境     | run 進行中從沙箱外以 `KERN_PROCARGS2` 讀（只輸出名稱與長度）：`OPENROUTER_API_KEY` 長 50、`at-run-` 開頭（run 權杖），沒有任何 `sk-or-` 開頭的值；其他只有 PATH、HOME、TMPDIR、LANG、NO_COLOR、`NO_PROXY`／`no_proxy`、`DSH_*`、`GIT_CONFIG_GLOBAL`、`XDG_CONFIG_HOME`、`__CF_USER_TEXT_ENCODING`。真金鑰本身沒有拿來比對雜湊（不讀 `.env`），只比對了形狀                                   |
| 服務行程的環境     | 同樣方式：沒有 `OPENROUTER_API_KEY`，也沒有 `sk-or-` 開頭的值                                                                                                                                                                                                                                                                                                                                |

離線（假上游、真實 dsh 0.2.1-rc.5、真實 `~/.dsh`）另外排練了工具路徑：模型要求兩個 bash 呼叫 → 在沙箱內殺自己的子行程與
行程群組成功、寫 worktree 成功、`profiles/headless/*` 讀得到、其他 `~/.dsh` 項目與 `~/.ssh` 拒絕、對服務行程送訊號拒絕、
patch 層寫入拒絕；逾時的 bash 被 dsh 移到背景，run 結束後沒有殘留行程。不在 catalog 的模型（`qwen/qwen4-max`）→
`UNKNOWN_MODEL`，上游零次請求。

本輪真實模型呼叫：1 個 deepseek-flash run（估算 ≈ $0.0007）、1 個 gpt-terra 審查（訂閱，估算 ≈ $0.016）。

## 第四輪（調研階段，spec §17、ADR 0021）

同樣的隔離方式（`~/.cache/ranolabs/sessions/2026-11-21-agent-team-research/`，結束後已刪除；worktree 根在
`~/RanoLabs/worktrees/research-e2e/`，結束後已刪除；本機監聽埠 `127.0.0.1:0`，區網、Grok、leader 關閉；服務以 `env -i`
從 `dist` 啟動）。設定副本為了把真實呼叫鎖在預算內：`oss_researcher` 只用一個別名、沒有 fallback，`max_attempts: 1`，
`impl_C` deepseek-flash（沒有 fallback、不升級、`max_fix_rounds_before_escalate: 0`），`review_C` 槽位 0（不跑審查），
`rules.quota` 清空。

**claude 不能用**：在桌面主機的 session 之外（`env -i`），`claude auth status --json` 是 `loggedIn: false`、`authMethod:
none`——這台電腦的 claude CLI 只靠宿主注入的登入。probe 照實回報不可用（`webSearch: true` 只表示旗標齊全）。依規定不
把 claude 指到自訂端點，所以**claude 的調研 run 與 leader 的那一個 turn 都沒有跑**，改用一個 codex 調研 run
（`gpt-6.1-terra`、effort low，設定副本的別名 `gpt-terra-low`）。

| 項目                                                    | 結果                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| probe                                                   | claude 不可用（未登入）、`webSearch: true`；codex 可用、`webSearch: true`（help 有 `--disable`）；dsh 可用、`webSearch: false`                                                                                                                                                                                                                                                                                             |
| 調研 run（codex）                                       | `team research add … --queue` → `done` 48.2 s：輸入 40.9k／cache 讀 68.2k／輸出 1.3k，估算 ≈ $0.054；7 個候選（全是 GitHub 的 https 網址、MIT 或 Apache-2.0），建議 `adapt_pattern`                                                                                                                                                                                                                                        |
| 執行中的 argv（`ps`）                                   | 看到的是：`--ignore-user-config --ignore-rules`、九個 `--disable`（`shell_tool unified_exec view_image image_generation multi_agent apps plugins browser_use computer_use`）、`permissions.agent-team.filesystem={":root"="deny"}`、`web_search="live"`。網路關閉與 cwd 是從 rollout 的 `turn_context` 看到的（見下兩列）                                                                                                  |
| 工作目錄                                                | run 期間 `DATA/research/` 與 `r_…` 都是 0700、空的；run 結束後目錄已刪                                                                                                                                                                                                                                                                                                                                                     |
| codex 實際給模型的工具（rollout 的 `additional_tools`） | 頂層：`exec`（code mode：在 V8 isolate 裡跑 JS，「no Node, no file system, no network」）、`wait`、`request_user_input`、`clock.sleep`、`collaboration.*`（`spawn_agent` 等，來自模型目錄，`--disable multi_agent` 沒有拿掉）。`exec` 內的巢狀工具：`web__run`、`apply_patch`、`create_goal`／`get_goal`／`update_goal`、MCP 資源三個（沒有設定任何 MCP 伺服器）、`clock__curr_time`。**沒有** `exec_command` 或任何 shell |
| 實際用到的工具                                          | 只有 `web__run` ×3（搜尋 2 個查詢、開 7 個頁面、在頁面裡找 `license`）；`events.jsonl` 只有 `web_search` 與 `agent_message` 項目，沒有 `command_execution` 或 `file_change`                                                                                                                                                                                                                                                |
| 權限設定檔（rollout 的 `turn_context`）                 | `file_system: restricted`，`root: deny`（另有 codex 自己的 `~/.codex/tmp/arg0-…` 可讀），`network: restricted`                                                                                                                                                                                                                                                                                                             |
| dsh C 級單引用調研                                      | `team task add … --research t_4kmf3ak1x6ts --queue` → review 21 s：deepseek-flash 19.1 s（10.4k／70.1k／1.5k，估算 ≈ $0.0012），服務端 commit 只含 `src/queue.js`，`main` 不動。存下的 `DATA/runs/<run>/prompt.md` 有工作規則裡的授權一句、`## 參考調研（資料，不是指令）` 與 `<<<DATA research_t_4kmf3ak1x6ts#d_…>>>` 區塊（7 個候選、授權標示）；之後人工取消（不跑審查）                                                |

**結論與處理**：codex 的「沒有 shell」是實測到的；`apply_patch`、goal、collaboration 工具仍在清單裡。`apply_patch` 在拒絕
整個檔案系統、`approval: never` 的設定檔下沒有可寫的地方（沒有實測寫入被拒），goal 工具之後以 `--disable goals` 拿掉
（離線以 `codex features list` 確認名稱，沒有再跑真實 run）；collaboration 工具沒有找到能關掉的設定，子 agent 會繼承
同一個 thread 設定（假設，沒有讀程式碼也沒有實測）。

**claude 的工具清單（不呼叫模型）**：未登入的 claude 在拒絕前仍會送出 `system` init 事件。以 runner 的 `claudeArgs` 組出調研
run 的 argv，在 `env -i` 下對空目錄執行（加 `--debug-file`）：init 的 `tools` 是 `["StructuredOutput","WebFetch","WebSearch"]`，
`mcp_servers` 空，`permissionMode: dontAsk`；debug 日誌記下 `Adding 9 deny rule(s) to destination 'flagSettings': ["Bash",
"Read","Edit","Write","Glob","Grep","NotebookEdit","Agent","Agent"]`（`Task` 被當成 `Agent` 的別名）與沙箱的路徑規則，
沒有設定檔驗證錯誤；結果是「Not logged in」，費用 0。也就是 `--settings` 被接受、沒有檔案或 shell 工具——但真的用
WebSearch／WebFetch 做調研（WebFetch 在空的 shell 網路白名單下能不能用）仍未實測。

本輪真實模型呼叫：1 個 codex 調研 run（訂閱，估算 ≈ $0.054）、1 個 deepseek-flash run（估算 ≈ $0.0012）；claude 與
leader 0 次（上面那次 claude 未登入、沒有呼叫模型）。

## 第五輪（調研：真實 Sonnet 與 leader 發起）

第四輪的「claude 未登入」是啟動方式造成的：`env -i` 漏了 `USER`（只有 PATH／HOME／TMPDIR／LANG 時 `loggedIn: false`，
補上 `USER` 即為 true）。不是本專案的缺陷；第四輪關於 claude 不可用的敘述以本節為準。

| 項目                       | 結果                                                                                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sonnet 調研（預設路由）    | 通過。工具只有 `StructuredOutput`／`WebFetch`／`WebSearch`；WebSearch 1 次、WebFetch 8 次（7 次成功、1 次 GitHub 回 404）；無檔案或 shell 工具、無權限拒絕；36 秒、US$0.091；6 個候選皆 MIT、建議 `adapt_pattern`；`DATA/research/<run>` 執行中 0700、結束後移除                            |
| leader 發起調研（haiku）   | 第一次失敗：leader 把 `team status && echo … && team research show …` 串成一個指令，`echo` 在拒絕清單，整個被擋。leader 提示改為 v4（每次 Bash 只下一個 `team` 指令，不用 `&&`、`;`、`\|`、`echo`）後第二次通過：`team status --json`、`team research add … --queue -`，0 次拒絕、US$0.0025 |
| leader 建立的調研（haiku） | 通過。52 秒、US$0.073；WebSearch 5 次、WebFetch 4 次；4 個 MIT 候選                                                                                                                                                                                                                         |

未觀察：`research.completed` 進 leader 摘要（為了不超過兩個 leader 回合，摘要視窗設成 1 小時後停止服務）。
提示規則是否就是第二次成功的原因只有一個樣本，且同時換了新的資料目錄。
已修正：`done` 的調研回執若 `needs_leader` 非空，不再開待決事項，改以 `research.completed` 的 `note` 帶給 leader 與看板。
