# 0007 SQLite 驅動與遷移

狀態：採用（phase 2）

**決定**：用 Node 內建 `node:sqlite`（`DatabaseSync`），在 `packages/db/src/driver/node-sqlite.ts`
自寫一個同步的 Drizzle session（`SQLiteSession`／`SQLitePreparedQuery` 子類 +
`BaseSQLiteDatabase('sync', …)`，約 150 行，照 drizzle 的 better-sqlite3 session 改寫，
`setReturnArrays` 取代 `.raw()`）。查詢用 Drizzle 的建構器，遷移用 drizzle-kit。

**本機驗證（Node 26.8.1、darwin arm64）**：

- drizzle-orm 0.45.4 沒有 `node:sqlite` 驅動（套件裡沒有對應目錄或 export）。
- `sqlite-proxy` 是非同步的（`BaseSQLiteDatabase<'async', …>`），不能實作同步的 repository（ADR 0002）。
- `better-sqlite3`：**未試裝，未驗證**。它的原生檔靠安裝腳本，而 `pnpm-workspace.yaml` 的
  `allowBuilds` 只列 esbuild（推測 pnpm 11 不會執行它的腳本），phase 2 又不改根設定；`node:sqlite`
  免編譯，也是 spec §2 的首選，所以沒有試。
- `node:sqlite` 不需旗標、沒有實驗警告；錯誤帶 `errcode`（2067 UNIQUE、1555 PRIMARYKEY），
  對應成 `UniqueViolationError`。

**做法**：

- 連線先設 `busy_timeout=5000`、`foreign_keys=ON`、`journal_mode=WAL`（不在交易內），再套遷移。
- `atomic()`：`BEGIN IMMEDIATE`／`COMMIT`；巢狀用 SAVEPOINT。多語句的 repository 方法
  （`messages.insert`、`effects.upsert`）也包在 `atomic()` 裡，單獨呼叫時一樣是原子的。
- 遷移：`drizzle-kit generate`（`prefix: 'timestamp'`）輸出到 `packages/db/drizzle/`；開啟時由
  `src/migrate.ts` 在一個 `BEGIN IMMEDIATE` 交易裡套用，記在 `migration` 表（tag、sha256、時間）。
  不用 Drizzle 內建 migrator（id 是 `SERIAL`、只比最後一筆時間戳、用一般 `BEGIN`）；自寫版另外拒絕
  套用後被改過的遷移與較新版本寫入的資料庫。
- 序號：`event.seq` 是 AUTOINCREMENT；`message.seq`、`effect.seq` 取自內部 `counter` 表（隨交易回滾，
  刪除後不重用，與記憶體版相同）。
- 不宣告外鍵：契約測試會存入父列不存在的資料（沒有 project 的 task 等），與記憶體版一致。

**後果**：

- 升級 drizzle-orm 時要確認 `SQLiteSession`／`SQLitePreparedQuery` 的抽象方法與未公開的
  `mapResultRow` 沒變（契約測試會抓到）。drizzle-orm 有官方 `node:sqlite` 驅動後改用它並更新本 ADR。
- 改 `src/schema/` 後執行 `pnpm --filter @agent-team/db db:generate --name <change>`；已提交的 SQL 不可再改。
