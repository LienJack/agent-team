import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// 每個 packages/* 與 apps/* 是一個 vitest project；測試直接跑原始碼（不需先 build）：
// 工作區套件的 exports 有 "@agent-team/source" 條件指向 src/。
// 有自己 vitest.config.ts 的套件（apps/web：jsdom + React 外掛，跑 *.test.ts 與 *.test.tsx）
// 直接用那份設定當 project，所以根目錄 `pnpm test` 也涵蓋元件測試。
const root = import.meta.dirname;
const dirs = ['packages', 'apps'].flatMap((group) =>
  readdirSync(join(root, group), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, group, d.name, 'package.json')))
    .map((d) => `${group}/${d.name}`),
);
const ownConfig = (dir: string) => join(root, dir, 'vitest.config.ts');

const sourceCondition = '@agent-team/source';

export default defineConfig({
  resolve: { conditions: [sourceCondition, 'module', 'node', 'default'] },
  ssr: { resolve: { conditions: [sourceCondition, 'module', 'node', 'default'] } },
  test: {
    passWithNoTests: true,
    projects: [
      ...dirs.filter((dir) => existsSync(ownConfig(dir))).map(ownConfig),
      ...dirs
        .filter((dir) => !existsSync(ownConfig(dir)))
        .map((dir) => ({
          extends: true as const,
          test: {
            name: dir.split('/')[1] ?? dir,
            root: join(root, dir),
            include: ['src/**/*.test.ts'],
          },
        })),
      {
        extends: true as const,
        test: { name: 'tools', root: join(root, 'tools'), include: ['**/*.test.mjs'] },
      },
    ],
  },
});
