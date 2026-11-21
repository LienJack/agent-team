# 開發慣例

補充 `AGENTS.md`。依據是 `docs/spec.md`；決定的理由在 `docs/adr/`。

## 模組與檔案

- ESM（`"type": "module"`）、`module`/`moduleResolution: nodenext`；相對 import 寫 `.js` 副檔名。
- 每個套件 `src/index.ts` 是唯一入口（core 另有 `@agent-team/core/testing`）。exports 有
  `@agent-team/source` 條件指向 `src/`，vitest 與 `tsx --conditions=@agent-team/source` 直接跑原始碼；
  `tsc -b` 與正式執行走 `dist/`。
- 測試與原始碼放一起：`src/**/foo.test.ts`。測試也會被 `tsc -b` 型別檢查（會輸出到 `dist/`，無妨）。
- 檔名 kebab-case；一檔一個主題；不超過 500 行。

## 命名與資料形狀

- 持久化與線上傳輸的形狀（領域物件、回執、事件、API DTO、設定檔）用 **snake_case**，和 spec、
  `models.json` 一致；可選欄位在領域物件裡是 `T | null`（欄位一定存在），在請求 DTO 裡是可省略。
- TypeScript 函式、ports 的參數、Runner 合約（`RunSpec`、`RunResult`、`RunnerCapabilities`）用
  **camelCase**（spec §7 原樣）。
- Zod schema 命名 `XxxSchema`，推導型別 `Xxx`。
- id：`<前綴><12 碼 base32>`，前綴見 `ID_PREFIXES`（`p_ t_ w_ r_ a_ m_`，另有 `d_` dispatch、`o_` outbox）。
- 時間：ISO 8601 UTC 字串（`Date#toISOString()`，含毫秒與 `Z`）；以字串比較即為時間順序。

## 錯誤

- core 丟 `TeamError` 子類：`NotFoundError`、`ValidationError`、`ConflictError`、
  `UniqueViolationError`、`VersionConflictError`、`InvalidTransitionError`、
  `IdempotencyConflictError`、`RequestInProgressError`。`code` 直接對應
  `ERROR_HTTP_STATUS` 與錯誤信封 `{ error: { code, message, hint? } }`。
- Runner 不丟例外：失敗寫在 `RunResult.error`（`kind` 見 `RunErrorKindSchema`）。

## Ports（phase 2 各自實作，彼此不需溝通）

| Port                                                                       | 檔案                                      | 實作者                               |
| -------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------ |
| `Store` + 11 個 repository                                                 | `packages/core/src/ports/repositories.ts` | `packages/db`（SQLite）              |
| `Runner`、`RunHooks`、`RunnerRegistry`、`Resumable`、`QuotaReporting`      | `packages/core/src/ports/runner.ts`       | `packages/runners`                   |
| `CheckExecutor`                                                            | `packages/core/src/ports/services.ts`     | `packages/runners`（共用子行程工具） |
| `GitPort`                                                                  | `packages/core/src/ports/git.ts`          | `packages/git`                       |
| `Clock`、`IdGen`、`Notifier`、`LeaderNotifier`、`EventPublisher`、`Logger` | `packages/core/src/ports/services.ts`     | `apps/server`（組裝）                |

重點契約（完整說明在各介面的 TSDoc）：

- **repositories 是同步的**；`Store.atomic(fn)` 的 `fn` 必須同步，丟例外就全部回滾。回傳的物件是複本。
  `tasks.update(next, expectedVersion)` 是比較後設定（樂觀鎖），版本不符回 `undefined`。
  唯一鍵衝突丟 `UniqueViolationError`。`events.append`、`messages.insert` 由 repository 配 `seq`。
- 實作 `Store` 的套件必須跑 `runRepositoryContract(name, factory, { teardown })`。
- `Runner.run` 一定 resolve；確認 agent 已啟動時呼叫一次 `hooks.onStarted`；無法判斷是否啟動回
  `start_unknown`；收到 abort 終止整個行程群組並回 `cancelled`；自己執行 `timeoutMs`。
- `RunSpec` 不放秘密（會存進 effect 表）；runner 自己取得它需要的那一個憑證。
- `GitPort` 的方法要能重複執行（effect 可能在重啟後重跑）；檔案清單為 repo 相對 POSIX 路徑，排序去重。
- `owned_paths` 的比對語意只有一份：`isPathOwned`／`ownedPathsOverlap`（`@agent-team/core`）。

## Engine 使用方式（apps/server）

```ts
const engine = new Engine({
  store,
  runners,
  git,
  checks,
  clock,
  ids,
  config,
  notifier,
  leader,
  publisher,
  logger,
});
await engine.recover(); // 啟動時一次
setInterval(() => void engine.tick(), cfg.engine.tick_ms); // 巡檢；指令與 run 完成時會自動 wake
engine.createTask(req, { kind: 'human' }); // 人觸發的動作可用保留槽
```

- 所有狀態變更走 engine 的指令；每個變更寫一筆 event，提交後交給 `EventPublisher`（SSE）與
  `LeaderNotifier`（`LEADER_EVENT_TYPES`）。
- 會改變狀態的 API 用 `withIdempotency(store, clock, { caller, requestId, method, payload }, handler)`。

## 測試

- core：`createTestEngine()`（記憶體 store、`ManualClock`、`SequentialIdGen`、每個 runner 一個
  `FakeRunner`、`FakeGit`、`FakeCheckExecutor`、`FakeNotifier`）。`await engine.runUntilIdle()`
  跑到沒事可做；有 `hold: true` 的 run 時用 `await engine.drain()`。時間只靠 `clock.advance(ms)`。
- 一個 `describe` 對應 spec §14 的一個項目，方便對照覆蓋範圍。
- 測試資料目錄一律 `mkdtemp(os.tmpdir())` 並在 `afterEach` 刪除。
