# 0001 工具鏈

狀態：採用（phase 1）

- **pnpm 11.25.0** workspace（`packages/*`、`apps/*`），`savePrefix: ''` 讓新增依賴自動寫確切版本。
- **TypeScript 7.0.2**（原生 `tsc`）。已在本機驗證 `tsc -b` + project references + `nodenext` +
  Zod 4 推導可用。strict、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、
  `verbatimModuleSyntax`。若後續遇到 7.x 不支援的工具（例如需要 TS JS API 的套件），改鎖 6.0.3 並更新本 ADR。
- `typecheck` = `tsc -b`：composite 專案被參照時不能 `noEmit`（TS6310），所以型別檢查會增量輸出到
  各套件的 `dist/`（git 忽略）。`build` = `tsc -b --force` 全部重建。
- **vitest 5.1.1**，根目錄 `vitest.config.ts` 的 `test.projects`（每個套件一個 project，另有 `tools`）。
  套件 exports 的 `@agent-team/source` 條件指向 `src/`，所以測試不需先 build。
- **oxlint 1.94.0**（`--deny-warnings`）。**oxfmt 0.79.0** 在本機可正常安裝與執行，採用它，不用 prettier。
  已知：oxfmt 偶爾要兩次才穩定（例如長的方法簽名），`pnpm format` 後再跑一次 `format:check`。
- husky 9.1.7 + lint-staged 17.6.1：pre-commit 對暫存檔跑 oxlint 與 oxfmt。`prepare: husky`
  會在安裝時設定 `core.hooksPath=.husky/_`（寫在主 checkout 與所有 worktree 共用的 `.git/config`）。
  注意 pnpm 11 在 `node_modules` 不存在時，`pnpm exec`／`pnpm <script>` 會先自動安裝並跑 `prepare`。
  CI 與不想裝 hook 時設 `HUSKY=0`（已驗證有效）。
- 測試與原始碼同放 `src/`，一起被 `tsc -b` 檢查。
