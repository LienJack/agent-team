import { expect, test } from '@playwright/test';
import { startServer, type TestServer } from './server.js';

// Board smoke (spec §14 web): open the LAN listener (no login, docs/adr/0024), see the board,
// create and queue a task, watch it reach 完成 through the event stream, answer an attention item
// from the web.

let server: TestServer;

test.beforeAll(async () => {
  server = await startServer();
  await server.local.createProject({
    name: 'demo',
    repo_path: server.repoPath,
    base_branch: 'main',
  });
});

test.afterAll(async () => {
  await server?.stop();
});

test('board → new task reaches 完成 → answer attention', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(server.lanUrl);

  // no login step: the board with its five columns and the live event stream right away
  await expect(page.getByLabel(/密碼/)).toHaveCount(0);
  for (const column of ['待派', '進行中', '待驗收', '阻塞', '完成']) {
    await expect(page.getByRole('heading', { name: column, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('status', { name: '即時連線：即時' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Runner 狀態' })).toContainText('claude');

  // create and queue a task
  const title = `冒煙測試 ${Date.now()}`;
  await page.getByRole('button', { name: '＋ 新增任務' }).click();
  const form = page.getByRole('dialog', { name: '新增任務' });
  await form.getByLabel('專案').selectOption({ label: 'demo' });
  await form.getByLabel('標題').fill(title);
  await form.getByLabel('owned_paths').fill('docs/');
  await form
    .getByLabel('派工單（Markdown）')
    .fill('# 派工單\n\n在 docs/ 加一個檔案。<script>x</script>');
  await expect(form.getByLabel('立即排入佇列（不勾選則建立為草稿）')).toBeChecked();
  await form.getByRole('button', { name: '建立並排入佇列' }).click();

  // the drawer opens on the new task; ticket text is shown as text
  const drawer = page.getByRole('dialog', { name: title });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('<script>x</script>', { exact: false })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  // fake runners: impl → verify → commit → review → done, pushed over SSE
  const done = page.locator('[data-column="done"]');
  await expect(done.getByRole('button', { name: title, exact: true })).toBeVisible({
    timeout: 60_000,
  });
  const card = done.getByRole('listitem').filter({ hasText: title });
  await expect(card).toContainText('完成');
  await expect(card.getByTitle(/^[0-9a-f]{40}$/)).toBeVisible(); // service-side commit sha

  // attention opened elsewhere (CLI/leader) appears live and is answered from the web
  const opened = await server.local.openAttention({
    question: '要部署到測試機嗎？',
    options: ['部署', '暫緩'],
  });
  // the top bar count updates live; it opens the attention view (a side panel only on wide screens)
  await page.getByRole('button', { name: '未決事項 1 筆' }).click();
  await expect(page.getByText('要部署到測試機嗎？')).toBeVisible();
  await page.getByRole('button', { name: '暫緩' }).click();
  await expect(page.getByText('目前沒有待決事項')).toBeVisible();
  const answered = await server.local.listAttention({ status: 'answered' });
  expect(answered.find((a) => a.id === opened.id)).toMatchObject({
    answer: '暫緩',
    answered_via: 'web',
  });
});
