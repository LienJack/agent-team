# @agent-team/db

SQLite（Node 內建 `node:sqlite`）+ Drizzle：`src/schema/` 是 spec §5 的資料表，`drizzle/` 是
drizzle-kit 產生的時間戳 SQL 遷移（開啟時自動套用，記在 `migration` 表），`src/repos/` 實作 core 的
repository ports。驅動與遷移的決定見 `docs/adr/0007-sqlite-driver.md`。

對外介面：`createSqliteStore({ path })` → `Store & { close() }`（WAL、`busy_timeout=5000`、
foreign keys on 並在 schema 宣告外鍵與「每個 task 一個非 removed workspace」的部分唯一索引；`atomic()` 是
`BEGIN IMMEDIATE`，巢狀用 savepoint）。以 `runRepositoryContract()` 驗證（與記憶體版同一組，含外鍵）。

改 schema 後：`pnpm --filter @agent-team/db db:generate --name <change>`。測試：
`pnpm --filter @agent-team/db test`。
