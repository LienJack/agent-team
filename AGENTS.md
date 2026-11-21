# AGENTS.md — agent-team 開發規範

寫給在這個 repo 裡工作的 agent（`CLAUDE.md` 是指向本檔的連結）。唯一依據是 `docs/spec.md`；
細節慣例在 `docs/conventions.md`，重要決定在 `docs/adr/`。

## 先看哪裡

- `docs/spec.md`：要做什麼。沒寫到的，選最簡單的做法並寫進回報（重要的寫 ADR）。
- `packages/schema`：所有資料結構（Zod）。新增欄位、事件、DTO 一律先改這裡。
- `packages/core/src/ports/`：其他套件要實作的介面（repositories、Runner、GitPort、CheckExecutor、
  Clock、IdGen、Notifier、LeaderNotifier、EventPublisher）。
- `packages/core/src/testing/`：假 runner／git／checks、手動時鐘、`runRepositoryContract()`。

## 分層（`pnpm check:boundaries` 會擋）

| 套件                               | 可以依賴                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                           | 只有 `zod`                                                                                                                                                                |
| `core`                             | `schema`（測試另可用 `vitest`）；**不碰 IO**：不 import node 內建模組、不用 `Date.now`／`new Date()`／計時器／`Math.random`／`process`，時間與 id 一律經 `Clock`、`IdGen` |
| `db`、`runners`、`git`             | `schema`、`core`（三者互不依賴）                                                                                                                                          |
| `client`                           | `schema`                                                                                                                                                                  |
| `apps/server`                      | 所有 packages                                                                                                                                                             |
| `apps/cli`、`apps/mcp`、`apps/web` | `schema`、`client`；apps 之間互不依賴                                                                                                                                     |

- 相對路徑 import 不可跨出自己的套件；跨套件一律用 `@agent-team/<name>`，並在 `package.json`
  宣告、在 `tsconfig.json` 加 project reference。
- 入口（CLI／MCP／web／Grok）只是 API 的包裝，不放業務邏輯；狀態只由 core 的 engine 改。

## 規則

- **單一原始檔不超過 500 行**，超過就拆。
- **不放秘密**：不讀、不印、不複製 `.env`；秘密不進程式碼、測試、日誌、資料庫、API 回應或
  `RunSpec`（它會存進 effect 表）。只有 `apps/server` 讀 `.env`，一次回傳一個變數。
- **要有測試**：改行為就加測試。core 用記憶體 store 與假 ports；實作 core 的 repository 時，
  必須用 `runRepositoryContract()` 跑同一組契約測試。
- 測試不得碰 `~/.agent-team`、`~/RanoLabs`，不得呼叫真實模型、網路服務或 Docker；用 OS 暫存目錄
  並自行清除。
- 依賴鎖定確切版本（`pnpm-workspace.yaml` 的 `savePrefix: ''`）；不在執行期 `npx -y` 下載。
- 資料與 API 形狀用 snake_case；TypeScript 函式、Runner 合約（`RunSpec`、`RunResult`）用 camelCase。
- 錯誤丟 `TeamError` 子類（`code` 對應 API 錯誤信封）。
- 不 `git commit --amend`、`--no-verify`、`push --force`。

## 檢查指令

```sh
pnpm install            # 第一次；HUSKY=0 可跳過安裝 git hook
pnpm lint               # oxlint（警告也算失敗）
pnpm format             # oxfmt 寫回；pnpm format:check 只檢查
pnpm typecheck          # tsc -b（project references，輸出到各套件 dist/）＋ e2e 的 tsconfig
pnpm test               # vitest，直接跑原始碼，不需先 build（含 apps/web 的 jsdom 元件測試）
pnpm test:e2e           # Playwright 看板冒煙（先 vite build；假 runner、leader 關閉、只綁 127.0.0.1）
pnpm build              # tsc -b --force，再 vite build 看板
pnpm start              # 需要時先建置，再從 dist 啟動服務（等同 team serve）
pnpm check:boundaries   # 分層、IO 純度、500 行上限
pnpm check:generated    # openapi.json 與 client 產生型別沒有漂移
```

只跑一個套件：`pnpm exec vitest run --project core`（或該套件的 `pnpm --filter @agent-team/<name> test`）。提交前六項（lint、typecheck、test、build、
check:boundaries、check:generated）都要過；pre-commit hook 會對暫存檔跑 oxlint 與 oxfmt。
