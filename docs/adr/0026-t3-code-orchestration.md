# 0026 T3 Code 當規劃與派工層，agent-team 服務當可信的把關者

狀態：採用（2026-11-23；新增 spec §19）

**背景**：T3 Code（本機已安裝的桌面 app）在「開 thread、派子 agent、多家模型、worktree 隔離、排程、PR」上比
agent-team 自己的 runner 與看板成熟：`delegate_task` 可把一張單交給 Claude／Codex／OpenCode（含 DeepSeek）的子
agent，`isolation: worktree` 給它自己的 checkout，人在 T3 的 UI 裡就看得到每個 worker 的對話。agent-team 有、而
T3 沒有的是規劃規則（Leader 提示：tier、owned_paths、驗收標準、何時調研、何時問人）與服務端把關（原則 1、2：不信任
agent 的自述，對照 git 實際變更、跑沙箱內的機器檢查，只提交核對過的檔案）。

**決定**：

1. **規劃與派工放在 T3**：skill `skills/t3-team/SKILL.md` 讓 T3 的主 thread 擔任 Team Leader——拆單規則照 Leader 提示
   v6，派工改用 `delegate_task`（`isolation: worktree`），tier 對應模型，`owned_paths` 有交集（或不確定）的單不同時派，
   人的決定用 T3 的提問。主 thread 不改程式碼。
2. **把關留在 agent-team 服務**：新增 `POST /api/gate`（spec §19）。主 thread 收到 worker 的回報後不採信，把它的
   worktree 交給服務核對：worktree 確實屬於該專案的 repo、不是主 checkout、不在基底分支；實際變更（以 git 為準，
   含未提交與未追蹤的檔案）全部落在 `owned_paths` 內；專案的機器檢查在既有的沙箱執行器裡全過；檢查後重算變更清單
   沒有多出檔案。全過才由服務端提交（只 `git add` 核對過的檔案、不跑 hooks）。這就是 spec §6 第 3–5 步，給外部的
   worktree 用。
3. **調研與記憶沿用服務**：調研用 `team research add`（調研 run 拿不到專案、只有網頁工具，§17），結果用
   `--research` 的回執內容附進派工單；記憶用 `team memory search`，合併後由 skill 以 `team memory add` 寫一筆
   （T3 的 session 用 operator 權杖，等同人；只在人同意合併之後寫）。
4. **驗收與合併只有人能做**：審查由另一個 delegate（模型與實作者不同）做；`must_fix` 進修正輪，上限 2 輪，用完問人
   （同 ADR 0025）。合併回基底分支前一律問人。

**gate 為什麼不落庫**：gate 不改任務狀態、不建 run，只對一個外部 worktree 做一次核對。它是冪等的：重跑時已提交的
變更仍在 `base_sha..HEAD` 裡、會再核對一次，未提交的部分為空就不再提交。所以 job 只存在記憶體（`GET /api/gate/:id`
查結果），服務重啟後遺失就重跑，不需要 effect 表。

**取捨**：

- 失去的：engine 的單一寫入者保證（派工編號柵欄、啟動復原、`start_unknown` 不重送、熔斷、額度冷卻）與看板狀態。
  T3 的 worker 跑在 T3 的權限模式裡，不是 agent-team 的 worker 沙箱（ADR 0014），所以它讀得到 worktree 以外的檔案；
  gate 只保證「提交進去的東西」是核對過的，不保證 worker 執行時沒碰別的。需要 worker 沙箱的工作仍交給原本的
  `team task add`（兩條路並存，skill 會說明怎麼選）。
- 得到的：T3 的 UI、多家模型、子 agent 管理與 worktree 生命週期，agent-team 不必再追著各家 CLI 的旗標改 runner。
