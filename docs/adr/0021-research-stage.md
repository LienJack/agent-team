# 0021 調研階段：讀網頁的 run 拿不到專案

狀態：採用（spec §17）

**問題**：規劃前先查有沒有可參考的開源專案，能省掉自己從頭設計的功夫（佇列、協定、演算法）。但調研 run 要讀的是任意
網頁，網頁內容等於攻擊者可控的輸入：一般 worker 的權限（讀寫 worktree、跑 shell、讀 repo 的 git 資料）加上讀網頁，
就是「被網頁指使去讀專案、再透過搜尋字串或回執把它帶出去」的完整路徑。

**決定**：

- 調研是一種任務（`task.kind = research`），不是每張單都跑的步驟；由 `service.json` 的 `research.mode` 控制
  （`off`／`on_request` 預設／`auto`），leader 的系統提示依 mode 帶入一句，mode 是提示版本的一部分。
- **與 repo 隔離**：調研 run 沒有 worktree，cwd 是服務端建立、run 結束即刪的空目錄 `DATA/research/<run_id>/`（0700）；
  `RunSpec` 沒有 `repoPath`、`allowNetwork: false`；提示只有題目（DATA 區塊）、規則與回執 schema，沒有專案名稱、路徑或
  其他派工單。工具只剩網頁搜尋與抓取：
  - claude：`--tools WebSearch,WebFetch`（`--restricted` 單獨不會拿掉 Read／Edit，所以 `--tools` 對調研 run 是必要旗標，
    沒有就 probe 回 `webSearch: false`）、`--allowedTools` 同一組、`--disallowedTools` 與 settings 的 deny 規則再拒絕一次
    `Bash Read Edit Write Glob Grep NotebookEdit Task Agent`。`--restricted --settings` 的沙箱照開（`failIfUnavailable`、
    不允許沙箱外指令、`autoAllowBashIfSandboxed: false`、家目錄與 DATA 拒讀、只開放空的 cwd、shell 網路白名單為空且
    strict）。WebSearch 在 Anthropic 端執行；WebFetch 是 Claude Code 自己的用戶端，由權限規則管。以上只有照劇本 CLI 的
    測試，以及一次不呼叫模型的檢查：未登入的 claude 2.1.326 照這組 argv 送出的 init 事件只有
    `StructuredOutput WebFetch WebSearch`，debug 日誌顯示 deny 規則與沙箱設定被接受（validation 第四輪）。真的調研
    run 沒有跑（這台電腦的 claude CLI 在宿主 session 之外沒有登入），WebFetch 在空的 shell 網路白名單下能否使用未實測。
  - codex：`--disable` 關掉 `shell_tool unified_exec view_image image_generation multi_agent apps plugins browser_use
    computer_use goals`（0.171.0 `codex features list` 的名稱；名稱不認得 codex 就不啟動），`web_search="live"`（由模型
    供應端執行），權限設定檔 `{":root"="deny"}`、`network.enabled=false`：就算還有指令能跑，連 `/bin` 都讀不到（以
    `codex sandbox` 離線實測 `cat /etc/hosts`：`read` 讀得到，`deny` 什麼都沒有）。`--disable` 不支援 → 沒有此能力。
    真實 run（validation 第四輪）的工具清單：沒有 shell；仍有 code mode 的 `exec`（JS isolate，沒有檔案系統與網路）包著
    `web__run`、`apply_patch`、MCP 資源與時鐘工具，以及模型目錄帶來的 collaboration（`spawn_agent` 等）工具。
    `apply_patch` 在拒絕整個檔案系統的設定檔下沒有可寫的地方（未實測寫入被拒）；collaboration 找不到關掉的設定。
    所以 codex 的限制主要是設定檔，而不是工具清單。
  - dsh：它的 `dsh-tool-web` 用 DeepSeek 的搜尋 API（`DEEPSEEK_API_KEY` 要進 worker 環境，違反 ADR 0020）並由 dsh 行程
    自己抓網頁（整個 Seatbelt 內的行程都要能連外）。宣告 `webSearch: false`，收到調研 spec 直接拒絕；不以 bash＋網路代替。
- 選模型：角色 `oss_researcher`；`resolveRole` 對調研 run 只接受 probe 宣告 `supports.webSearch` 的 runner（沒有 probe
  結果視為沒有）。沒有任何別名有能力 → 任務阻塞並說明；有能力但在冷卻 → 照常等待。
- 結果只有一份回執（`ResearchReceipt`）：Zod、`dispatch_id`、上限（8 個候選、每個字串有長度上限、網址 ≤ 400、
  `needs_leader` ≤ 600——它會原樣變成待決事項）、網址必須
  `https:` 且不含帳密；字串遮蔽後再截一次、網址再驗一次。服務端不連那些網址，看板、CLI、MCP、leader 摘要都標「連結
  未經服務端驗證」。

**剩下的風險**：回執的文字仍是受攻擊者影響的資料，會到 leader（事件摘要、`team research show`）與引用它的 worker
（impl／fix／review 提示）。界線是：schema 上限讓它短；它只出現在帶 dispatch id 或 seq 的 DATA 區塊內（標記已拆解，無法
提前關閉區塊），規則明說是資料不是指令、非寬鬆授權只能參考做法；leader 沒有只屬於人的權限（驗收、回答、改派、建專案），
worker 仍在各自的沙箱裡且以 git 與機器檢查核對。另外：WebFetch 從這台電腦連出去，Claude Code 會擋 `localhost` 與私有
網段——這是從 Claude Code 執行檔字串讀到的（其中一段描述的是別的產品面），沒有實測，而「沒有點的主機名」那條擋不住
`127.0.0.1` 或區網 IP：原則上這台電腦或區網上的其他服務可能被抓到（本服務的 API 都要權杖）。搜尋字串本身是模型決定的，
提示裡只有題目，所以能洩漏的只有題目與網頁內容。codex 的調研 run 只有真實測過一次；claude 的調研 run 沒有真實測過。
（2026-11-22）「本服務的 API 都要權杖」已不成立：區網監聽埠不需權杖（ADR 0024），連得到這台電腦區網 IP 的
WebFetch 可以讀（GET）看板資料與 run 日誌。

**驗證**：`packages/core/src/engine/research*.test.ts`、`packages/runners/src/research-runners.test.ts`（照劇本的 CLI 釘住
argv 與 settings）、`apps/server/src/research.test.ts`、`packages/db/src/migrate-research.test.ts`；真實 run（1 個 codex
調研 run、1 個引用它的 dsh 實作 run）見 `docs/validation-2026-11-21.md` 第四輪。

## 更正（第五輪實測）

上面「claude CLI 在宿主 session 之外沒有登入」不成立：第四輪啟動服務時用 `env -i` 且漏了 `USER`，claude 因此判定未登入
（只補 `USER` 即恢復；runner 本身會傳 `USER`）。第五輪用真的 Sonnet 經服務跑過調研：CLI 只提供
`StructuredOutput`、`WebFetch`、`WebSearch`，WebSearch 與 WebFetch 在空的網路白名單下都能用，沒有檔案或 shell 工具，
暫存目錄於結束後移除。細節見 `docs/validation-2026-11-21.md` 第五輪。
