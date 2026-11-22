# 0022 營運防護：派工狀態由程式說、額度等待有上限、Grok 按鈕有規則、逃出群組的行程

狀態：採用（spec §8、§9、§10、§11、§12；做法參考另一個專案 makecindy/cindy 的描述，程式為本專案自寫）

## 1. leader 不能誤報派工狀態

**問題**：leader 會把只是排隊的任務說成「執行中」——它用自己的話描述 `team task add` 的結果。

**決定**：每個任務指令（`POST /tasks`、`/research`、`/tasks/:id/{queue,cancel,retry,approve,reject,reassign}`）的回應
是 `{ task, delivery, report }`：先等一次排程（`Engine.settle()`：進行中的那一輪可能早於這次 commit，所以等它之後再跑
一輪；伺服器最多等 3 秒），再**從資料庫現況**推導 `delivery`（`running`：有活著的 run 或正在核對｜`queued` 附 `task.waiting`
的原因（未知為 null）｜`draft`｜`done`｜`not_accepted` 附原因：阻塞、失敗、取消），`report` 是程式產生的一行繁中
（`packages/schema` 的 `deliveryReport`，狀態對照表是 `Record<TaskStatus,…>`，新增狀態時型別檢查會擋）。`done` 是使用者
列出的四種之外多的一種：重放或很快的 run 會遇到，說成 running／queued 都不對。同一個 Idempotency-Key 重放時（leader 的
turn 重跑）task、delivery、report 依現況重算，不回舊的。CLI 的 `task add|queue|cancel|retry`、`research add` 在純文字與
`--json`（task 欄位照舊在頂層，另加 `delivery`、`report`）都印出；被拒、連不上、用法錯誤也印 `delivery: not_accepted`
與 report（結束碼不變；leader 的 shim 拒絕 `--ticket-file`／`--question-file` 時也印這兩行；commander 自己的參數錯誤
（缺必要選項）沒有）。`GET /state` 加 `summary`：五欄計數加總等於 `total`（不含已取消，另計），`team status` 印
`report:` 這一行。目前沒有批次指令；多筆結果的寫法（`deliveriesReport`：各狀態計數加總等於總數）已備好並測試。leader
提示 v5 加一條：回報任務狀況時轉述 `report`，`delivery` 不是 `running` 就不說在執行。

## 2. 額度等待的防護

**決定**（`packages/core/src/engine/quota-wait.ts`，純函式）：回報的重置時間在過去、等於現在或超過 8 天後 → 當作不明
（照舊 15 分鐘）；已知的加 60 秒緩衝與 0–30 秒的抖動（runner 名稱＋重置時間的 FNV-1a，不用亂數）。runner 冷卻、
`quota.exhausted` 的停用（以回報時間 `updated_at` 判斷上限，舊的設計會被 30 天後的重置值停用一個月）、leader 自己的
rate limit 都走同一個函式。**迴圈防護**：冷卻開始時設 `probe_after_cooldown`；冷卻結束後**第一個開始的 run** 又撞到
rate limit 才算一圈（冷卻前已在跑的 run 回來的 rate limit 不算，一個冷卻窗只算一次）；成功的 run 歸零。連續
`engine.rate_limit_loop_limit`（3）圈 → `halted_at`：熔斷開著不會自己半開、開一筆待決事項（topic `runner_halted`，
選項「重新啟用」）、事件 `runner.halted`，角色照冷卻時一樣改用 fallback。回答該事項（任何答案、任何管道）或人重試一個
會用到該 runner 的任務 → 重新啟用（計數歸零，事項 superseded）；leader 的重試不算。

## 3. Grok 選項按鈕

**決定**：待決事項多一個 `topic` 欄位（開事項的地方設定，不從文字推斷；遷移把舊列設為 `unclassified`）與一張
風險表 `ATTENTION_TOPIC_RISK`（schema，窮舉）：`base_drift`（重建會捨棄 worktree）、`start_unknown`、`worker_unconfirmed`、
`worktree_identity`、`workspace_kept`、`unclassified` 是 high。hub 送出時（`sendAttention` 與帶著事項的最終回覆）與收到
Grok 的回答時用同一個判斷（`apps/server/src/hub/buttons.ts`）：全部只有這一筆待決事項、不是 high、有選項、問題與每個
選項都不截斷地放得下 → 才帶按鈕／才接受；否則送純文字，問題與選項原樣，附 `team attention answer <id> "<選項>"` 並說明
原因，Grok 的回答（按鈕或打出選項原文）回一句沒有記錄與原因，不轉給 leader。core 的 `answer()` 另外拒絕 `via: grok` 回答
high 的事項（縱深）。長度上限在 `grok.buttons`：grokmsg 推送最多 6000 字、帶選項的回覆最多回傳 300 字的問題；它沒有寫按鈕
文字的上限，40 字、最多 5 個是**假設值**。

## 4. 逃出行程群組的 worker 後代

**評估**（真實的短命行程，不用模型）：worker 產生三種後代——同群組的子行程、`setsid()` 的子行程、double-fork 的 daemon。
改之前：逾時、取消（關機也是中止 run）、正常結束、當機復原，四種情況下同群組的都被終止，**setsid 子行程與 daemon 全部
存活**。

**決定**：

- `killGroup` 在送訊號前先讀行程表（`ps`），依父子關係找出離開群組的後代，先送它們（子先於父）再送群組；寬限後 SIGKILL
  前以 pid＋啟動時間重新核對，不碰被重用的 pid。復原的 `terminateGroup` 也走這裡。
- 父行程已結束的（daemon、正常結束後的 setsid 子行程）父子關係已斷，只能靠**擁有權證明**：父行程是 init、同一使用者、
  沒有控制終端、啟動時間不早於 run 的啟動（秒精度）、不在服務自己的祖先鏈上、不是 macOS app bundle（`….app/Contents/`：
  人開在 worktree 上的 GUI 編輯器也沒有終端、父行程也是 launchd），而且工作目錄在該 run 自己的路徑內，或命令列含該路徑
  （以路徑段為界）。路徑是 worktree（`<root>/<project>/<task_id>`）、調研目錄、run 日誌目錄；少於三段、根目錄、
  家目錄、暫存目錄與它們的上層一律不算；先 realpath。符合者連同它的後代終止。worker run、機器檢查與 codex（它的 wrapper
  自己殺群組、不做快照）結束時都掃一次，run 的結果等掃完才回；服務自己的 grokmsg、leader turn 不帶路徑、不掃。
  另一個 agent-team 實例的路徑在它自己的 DATA／任務 id 下，不會符合。
- 啟動復原：群組處理完後對同一個 run 掃一次；有證明卻殺不掉 → `unconfirmed`（阻塞、開事項）；只剩群組成員而它們被
  證明並清掉 → 再看一次群組，空了就照常重排。沒有 pid 的 run 照舊阻塞（清掉證明得了的，但 worker 本身無法交代）。
- 讀不到行程表或工作目錄的平台（不是 macOS／Linux、工具失敗）→ 不掃，維持原本只處理群組的行為。最後確認時讀不到行程表
  → 還回應訊號的都當成存活（fail closed，復原因此阻塞）。`lsof` 用 `-b`（不做會卡住的系統呼叫，NAS 掛載點不會拖住 run 的
  結束），工具逾時 5 秒；只把候選（父行程 init、同使用者、無終端、run 之後啟動）交給 `lsof`。
- 強制結束（第二次 Ctrl-C）只同步 SIGKILL 各 run 的群組；逃出的後代由下次啟動的復原處理（那些 run 在資料庫裡仍是
  `running`）。

**改之後**（`packages/runners/src/process/escape.test.ts`）：四種情況三種後代都消失；不帶路徑時 daemon 仍存活；比 run
早啟動的、父行程還活著的、在別的任務目錄裡的行程都不動。

**後果與限制**：環境變數裡的標記沒有用：macOS 讀不到平台執行檔（`/bin/sh`、`sleep`）的環境。自己 `chdir("/")` 又不在
命令列留路徑的 daemon 無法歸屬、會存活。在 worktree 裡（或命令列帶著它的路徑）、沒有終端、父行程已結束、不是 app bundle、
在時間窗內啟動的別人的行程會被當成 run 的——執行期的時間窗是 run 的期間；**復原時是 run 啟動到服務重啟**，所以當機後有人
在 worktree 裡 `nohup` 後關掉終端機，或用命令列帶路徑開了一個不在 app bundle 裡的工具，重啟時會被終止。Linux 只寫了
`/proc` 的讀法，沒有在本機測；而且 Linux 上孤兒常被 subreaper（`systemd --user`）而不是 pid 1 收養，那時「父行程是 init」
不成立、什麼都不會被掃，等於只在 macOS 上有效。每個 run 結束多一次 `ps`，有候選時多一次 `lsof`。
