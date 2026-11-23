# 0020 金鑰代理：真正的 OpenRouter 金鑰不進任何子行程

狀態：採用（第三輪安全審查；補充 spec §1.8、§4 金鑰、§7 dsh，取代 ADR 0019 之前「`OPENROUTER_API_KEY` 只放進 dsh
子行程的環境」）

**問題**：同一使用者的任何行程都讀得到另一個行程啟動時的環境（`sysctl KERN_PROCARGS2`）。審查者以 canary 實測，
Seatbelt 的 `process-info*`、`sysctl-read` 規則都擋不住。每個 dsh worker 的環境裡都有真的 `OPENROUTER_API_KEY`：沙箱內的
機器檢查、另一個 run、或使用者的任何工具都能把它讀走。事後清掉 `process.env` 沒有用——被讀的是 exec 時的那一份。

**先確認 dsh 能不能改端點**（離線）：dsh 0.2.1-rc.5 的 OpenRouter 路由是 `@deepseek-ai/dsh-llm-pi-ai` 的
`providers.openrouter`，支援 `baseURL`（覆蓋該路由所有模型的端點）與 `apiKeyEnv`（從哪個環境變數取 bearer）。
OpenRouter 是 pi-ai 內建的 catalog 路由，`provider === "openrouter"` 的相容判斷不看網址，換 `baseURL` 不改變請求格式；
catalog 路由不做背景的模型清單刷新（`/models/user`）。`models.json` 裡 catalog 有的 dsh 模型全是 `openai-completions`，
請求是 `POST {baseURL}/chat/completions`（OpenAI SDK，不加查詢字串）。以假上游實測：dsh 送出主 turn 與標題各一個
`POST /api/v1/chat/completions`，bearer 就是環境變數的值。（`qwen/qwen4-max`、`google/gemini-4-carbon` 不在這版 catalog
裡，與代理無關，本來就是 `UNKNOWN_MODEL`。）

**決定**：

- `apps/server/src/model-proxy.ts`：服務端（唯一讀 `.env` 的地方）在 `127.0.0.1` 的臨時埠跑金鑰代理。每個 dsh run 開始時
  發一個隨機權杖（`at-run-` + 32 bytes base64url；代理只存它的 sha-256），run 結束（`runCli` 回傳後，含逾時、取消、失敗）
  就撤銷，撤銷時中斷該 run 仍在進行的轉送。代理只接受：`POST`、路徑**完全等於** `/api/v1/chat/completions`（沒有查詢字串、
  沒有 absolute-form）、`Authorization: Bearer <有效權杖>`；其他一律 404／401，不碰上游。CONNECT 與 upgrade 沒有處理器，
  連線直接關閉。上游固定為 `https://openrouter.ai`（`node:https`、預設 CA，不跟隨轉址），換上真金鑰，丟掉 hop-by-hop、
  `cookie`、`x-api-key`、`api-key`、`forwarded`、`x-forwarded-*`；回應原樣串流（SSE、壓縮內容不解開），丟掉 `set-cookie`。
  只記 run id、狀態碼、毫秒與錯誤碼，從不記標頭或內容。沒有金鑰 → 503。測試以 `upstreamForTests` 換成 loopback 上的假上游
  （只接受 `127.0.0.1`）；正式環境沒有任何設定能改上游。
- runner 介面：`ModelKeyBroker`（`packages/runners/src/types.ts`：`hasKey()`、`open(runId) → { token, baseUrl, port,
  revoke }`），core 不需要知道，所以不是 core 的 port；`createRunnerRegistry({ dsh: { keys } })` 傳入。`@agent-team/runners`
  不再有 `EnvReader`：沒有任何 runner 讀憑證。沒有 broker、broker 沒有金鑰、或代理沒在聽 → dsh `credentials: missing`、
  不可用、不 spawn；服務環境裡的真金鑰**不是**後備。
- dsh 的 patch 加 `llm-pi-ai` → `providers.openrouter`：`apiKeyEnv: OPENROUTER_API_KEY`、`baseURL:
  http://127.0.0.1:<代理埠>/api/v1`；子行程的 `OPENROUTER_API_KEY` 是 run 權杖，`NO_PROXY`／`no_proxy` 補上
  `127.0.0.1,localhost,::1`（權杖絕不經環境裡的外部 HTTP 代理；dsh 自己也一律繞過 loopback）。日誌與錯誤訊息以字面值與
  `at-run-` 樣式遮蔽權杖。
- 埠：代理的埠加進 `servicePorts`，機器檢查的設定檔照樣拒絕它；dsh 的設定檔只把這一個埠從服務埠規則裡拿掉（ADR 0019
  第三輪）。代理在 runner probe 之前啟動、在服務關閉的最後（所有 run 結束之後）關閉；啟動失敗只記警告，dsh 不可用。
- 服務自己的環境：同樣讀得到，所以不去清它；啟動時若 `OPENROUTER_API_KEY`、`TEAM_LAN_PASSWORD`、`JEV_API_KEY`
  出現在行程環境（而不只在 `.env`），每個記一條 `secret in the process environment` 警告（只寫名稱），README 說明。
  （2026-11-22）`TEAM_LAN_PASSWORD` 已移除（ADR 0024）；本 ADR 其他提到它的地方是當時的紀錄。

**子行程環境稽核**（`process/env.ts` 的白名單 `BASE_ENV_NAMES` = PATH、HOME、USER、LOGNAME、SHELL、TMPDIR、LANG、LC_*、
TERM、TZ、代理變數（去掉 userinfo）、SSL_CERT_FILE／DIR、NODE_EXTRA_CA_CERTS、`__CF_USER_TEXT_ENCODING`，另加 `NO_COLOR=1`）：

| 子行程           | 白名單之外                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| claude worker    | `CLAUDE_CONFIG_DIR`；worker git 變數（`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_*` 排除檔）                                                                 |
| leader 的 claude | `CLAUDE_CONFIG_DIR`；PATH 前面加 `team` shim 目錄（shim 從 0600 的檔案讀 leader 權杖，不經環境）                                                             |
| codex            | `CODEX_HOME`；同上的 git 變數；bundled binary 的 PATH 目錄                                                                                                   |
| dsh              | `DSH_HOME`；`OPENROUTER_API_KEY=<run 權杖>`、`DSH_TELEMETRY_DISABLED`、`DSH_PERMISSION_MODE`、`GIT_CONFIG_GLOBAL`、`XDG_CONFIG_HOME`、`NO_PROXY`／`no_proxy` |
| 機器檢查         | `CI=1`、`GIT_TERMINAL_PROMPT=0`、worker git 變數                                                                                                             |
| grokmsg          | `GROKMSG_HOME`、`GROKMSG_ENV_FILE`（路徑；grokmsg 自己讀它的權杖）                                                                                           |
| 服務端 git       | git 自己的白名單（無 `GIT_*` 覆寫）、`LC_ALL=C`、`GIT_TERMINAL_PROMPT=0`、`GIT_EDITOR=true`、`GIT_PAGER=cat`、作者身分                                       |

沒有任何子行程拿到 `OPENROUTER_API_KEY`（真值）、`TEAM_LAN_PASSWORD`、`JEV_API_KEY`、`SSH_AUTH_SOCK`、`AGENT_TEAM_*` 或
權杖。claude 與 codex 用它們自己的登入，從不指向自訂的 base URL。

**驗證**：`model-proxy.test.ts`（假上游：上游收到真金鑰、看不到權杖；`cookie`／`x-api-key` 不轉送；10 種不允許的請求
全部 401／404 且上游零次請求；SSE 第一個事件在上游結束前就送達；gzip 原樣通過；撤銷後 401 且進行中的轉送被中斷；
沒有金鑰 503；上游失敗 502 不帶細節；日誌裡沒有金鑰、權杖、內容或 authorization；CONNECT 被關閉；非 loopback 的測試上游
被拒）。`dsh.test.ts`：子行程的 `OPENROUTER_API_KEY` 摘要等於本次權杖、沒有任何環境值等於真金鑰的摘要、服務環境的
`TEAM_LAN_PASSWORD` 不在、`NO_PROXY` 含 loopback、patch 有 `llm-pi-ai` 端點、run 結束權杖已撤銷；沒有 broker／沒有金鑰／
代理沒在聽 → `auth`、不 spawn。`main.test.ts`、`env.test.ts`：警告只寫名稱。`process/env.test.ts`：白名單沒有任何憑證名稱，
帶滿秘密的來源環境只留下 PATH。

離線排練（真實 `DshRunner` + 真實代理 + 假上游 + 真實 dsh 0.2.1-rc.5、新設定檔、真實 `~/.dsh`，環境裡另設一個假的外部
`HTTPS_PROXY`）：2.6 s 完成 run；上游收到兩個 `POST /api/v1/chat/completions`，bearer 都是（假的）真金鑰；外部代理零次
請求；run 結束後有效權杖 0；執行中以 `KERN_PROCARGS2` 從沙箱外讀 dsh 行程的環境：`OPENROUTER_API_KEY` 長 50、`at-run-`
開頭，沒有任何值等於假金鑰的 sha-256、也沒有 `sk-or-` 開頭的值。真實模型的驗證見 `docs/validation-2026-11-21.md` 第三輪。

**剩餘風險**：run 進行中，同一使用者的其他行程讀得到該 run 的權杖（同一個 `KERN_PROCARGS2`），在 run 結束前可經代理花用
額度——但只能打 chat/completions、拿不到金鑰本身，run 一結束就失效。代理直接連 OpenRouter，不經環境的 `HTTPS_PROXY`
（需要外部代理才能上網的環境，dsh 目前連不到；以前是 dsh 自己走代理）。代理沒有速率或花費上限。dsh 升級時重新確認
`llm-pi-ai` 的 `baseURL`／`apiKeyEnv` 與它實際打的路徑（`dsh.test.ts` 釘住 patch；路徑只由離線排練確認）。
