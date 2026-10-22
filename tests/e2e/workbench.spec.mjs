import {readFile} from 'node:fs/promises';
import {test as base, expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Every browser request is intercepted. Tests cannot fall through to Crossref,
// analytics, DOI resolvers, Zotero, or any other external service.
const test = base.extend({
  // Playwright requires destructuring even when a fixture has no dependencies.
  // eslint-disable-next-line no-empty-pattern
  crossref: async ({}, use) => {
    await use({requests: [], respond: null});
  },
  networkGuard: [async ({context, crossref}, use) => {
    const unexpected = [];
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === 'http://127.0.0.1:4173') return route.continue();
      if (url.origin === 'https://api.crossref.org' && url.pathname === '/works' && crossref.respond) {
        crossref.requests.push(url);
        const response = await crossref.respond(url);
        return route.fulfill({contentType: 'application/json', ...response});
      }
      unexpected.push(request.url());
      await route.abort('blockedbyclient');
    });
    await use();
    expect(unexpected, 'All external requests must have an explicit offline mock').toEqual([]);
  }, {auto: true}],
});

const paper = {
  id: 'https://www.zotero.org/users/123/items/ABCD1234',
  type: 'article-journal',
  title: 'Reliable metadata matching for scientific literature',
  author: [{family: 'Chen', given: 'Lin'}],
  issued: {'date-parts': [[2024]]},
  'container-title': 'Example Research Journal',
};
const secondPaper = {
  ...paper,
  id: 'https://www.zotero.org/users/123/items/EFGH5678',
  title: 'Accessible tools for scholarly reference management',
};
const existingPaper = {
  ...paper,
  id: 'existing-reference',
  title: 'An existing reference with a DOI URL',
  DOI: 'https://dx.doi.org/10.5555/already-assigned',
  note: 'Preserve original metadata',
};

function responseFor(item, doi = '10.5555/matching-study') {
  return {json: {message: {items: [{
    DOI: doi,
    title: [item.title],
    author: item.author,
    issued: item.issued,
    'container-title': [item['container-title']],
    type: 'journal-article',
  }]}}};
}

async function importItems(page, items) {
  await page.locator('#file-input').setInputFiles({
    name: 'references.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(items)),
  });
  await expect(page.locator('#stat-total')).toHaveText(String(items.length));
}

async function assertAccessible(page) {
  const result = await new AxeBuilder({page}).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(result.violations).toEqual([]);
}

async function attachScreenshot(page, testInfo, name) {
  await testInfo.attach(name, {body: await page.screenshot({fullPage: true}), contentType: 'image/png'});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('keyboard import tabs, invalid JSON, and named accessible help', async ({page}, testInfo) => {
  await page.goto('/');
  await expect(page).toHaveTitle('title2doi · DOI 批量补全 | Web Apps');
  await expect(page.getByRole('button', {name: '开始批量查询'})).toBeDisabled();
  await assertAccessible(page);
  await attachScreenshot(page, testInfo, 'empty-workbench');
  if (testInfo.project.name === 'mobile') {
    const stats = await page.locator('.stats > div').evaluateAll(cards => cards.map(card => ({
      x: card.getBoundingClientRect().x,
      y: card.getBoundingClientRect().y,
      labelSize: parseFloat(getComputedStyle(card.querySelector('span')).fontSize),
    })));
    expect(stats).toHaveLength(4);
    expect(stats.every(card => card.labelSize >= 12)).toBe(true);
    expect(stats[0].y).toBe(stats[1].y);
    expect(stats[2].y).toBeGreaterThan(stats[0].y);
    expect(stats[2].x).toBe(stats[0].x);
    expect(stats[3].x).toBe(stats[1].x);
  }

  const fileTab = page.getByRole('tab', {name: '上传文件'});
  const pasteTab = page.getByRole('tab', {name: '粘贴内容'});
  await expect(pasteTab).toHaveAttribute('tabindex', '-1');
  await fileTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(pasteTab).toBeFocused();
  await expect(pasteTab).toHaveAttribute('aria-selected', 'true');
  await expect(fileTab).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('Home');
  await expect(fileTab).toBeFocused();
  await page.keyboard.press('End');
  await expect(pasteTab).toBeFocused();
  await page.getByRole('textbox', {name: 'Zotero CSL JSON 内容'}).fill('not JSON');
  await page.getByRole('button', {name: '解析文献'}).click();
  await expect(page.locator('#notice')).toContainText('无法解析 JSON');
  await expect(page.locator('#stat-total')).toHaveText('0');

  const help = page.getByRole('button', {name: '查看使用指南'});
  await help.click();
  await expect(page.getByRole('dialog', {name: '从导出到回填，全程批量。'})).toBeVisible();
  await assertAccessible(page);
  await page.keyboard.press('Escape');
  await expect(help).toBeFocused();
});

test('import, mocked query, confirmation, export, and restore retain original metadata', async ({page, crossref}, testInfo) => {
  crossref.respond = () => responseFor(paper);
  await page.goto('/');
  await importItems(page, [paper, existingPaper]);
  await expect(page.locator('[data-doi="1"]')).toHaveAttribute('href', 'https://doi.org/10.5555/already-assigned');
  await page.getByRole('button', {name: '开始批量查询'}).click();
  await expect(page.locator('#progress-text')).toHaveText('本批查询完成 · 1 条');
  expect(crossref.requests).toHaveLength(1);
  expect(crossref.requests[0].searchParams.get('query.bibliographic')).toBe(`${paper.title} Chen 2024`);
  expect(crossref.requests[0].searchParams.get('rows')).toBe('5');
  await expect(page.locator('#stat-high')).toHaveText('1');
  await page.getByRole('checkbox', {name: `确认匹配：${paper.title}`, exact: true}).check();
  await expect(page.locator('#confirmed-count')).toHaveText('1');
  await assertAccessible(page);
  await attachScreenshot(page, testInfo, 'confirmed-results');

  await page.getByRole('button', {name: '批量回填 Zotero', exact: true}).click();
  await expect(page.getByRole('dialog', {name: '把 1 个 DOI 带回 Zotero'})).toBeVisible();
  await assertAccessible(page);
  // The generated Zotero script is only read; it is never executed.
  await expect(page.locator('#script-output')).toHaveValue(/return await run\(payload, false, Zotero/);
  await expect(page.locator('#script-output')).toHaveValue(/10\.5555\/matching-study/);
  await page.getByText('其他导出方式', {exact: true}).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', {name: '下载 CSL JSON', exact: true}).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('zotero-with-doi.json');
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(exported).toEqual([{...paper, DOI: '10.5555/matching-study'}, existingPaper]);

  await page.reload();
  await expect(page.locator('#notice')).toContainText('已恢复上次的 2 条文献及核对进度');
  await expect(page.getByRole('checkbox', {name: `确认匹配：${paper.title}`, exact: true})).toBeChecked();
  await expect(page.locator('[data-doi="1"]')).toHaveAttribute('href', 'https://doi.org/10.5555/already-assigned');
  expect(crossref.requests).toHaveLength(1);
});

test('percent characters survive imported DOI links, candidate review, and export', async ({page, crossref}) => {
  const doi = '10.5555/part%2Fencoded%20value';
  const url = 'https://doi.org/10.5555/part%252Fencoded%2520value';
  const existing = {...existingPaper, DOI: url};
  crossref.respond = () => responseFor(paper, doi);
  await page.goto('/');
  await importItems(page, [paper, existing]);
  await expect(page.locator('[data-doi="1"]')).toHaveAttribute('href', url);
  await page.getByRole('button', {name: '开始批量查询'}).click();
  await expect(page.locator('#progress-text')).toHaveText('本批查询完成 · 1 条');
  await expect(page.locator('[data-doi="0"]')).toHaveAttribute('href', url);
  await page.locator('[data-review="0"]').click();
  const dialog = page.getByRole('dialog', {name: '找到的是同一篇文献吗？'});
  await expect(dialog.getByRole('link')).toHaveAttribute('href', url);
  await dialog.getByRole('button', {name: '确认使用', exact: true}).click();
  await page.getByRole('button', {name: '批量回填 Zotero', exact: true}).click();
  await page.getByText('其他导出方式', {exact: true}).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', {name: '下载 CSL JSON', exact: true}).click();
  const download = await downloaded;
  expect(JSON.parse(await readFile(await download.path(), 'utf8'))).toEqual([{...paper, DOI: doi}, existing]);
});

test('confirmation and candidate dialogs keep keyboard focus even when filters remove rows', async ({page, crossref}, testInfo) => {
  crossref.respond = url => url.searchParams.get('query.bibliographic').startsWith(paper.title)
    ? responseFor(paper)
    : responseFor(secondPaper, '10.5555/accessible-tools');
  await page.goto('/');
  await importItems(page, [paper, secondPaper]);
  await page.getByRole('button', {name: '开始批量查询'}).click();
  await expect(page.locator('#progress-text')).toHaveText('本批查询完成 · 2 条');

  const firstCheckbox = page.getByRole('checkbox', {name: `确认匹配：${paper.title}`, exact: true});
  await firstCheckbox.focus();
  await page.keyboard.press('Space');
  await expect(firstCheckbox).toBeChecked();
  await expect(firstCheckbox).toBeFocused();
  await page.keyboard.press('Space');
  await expect(firstCheckbox).not.toBeChecked();
  await expect(firstCheckbox).toBeFocused();

  const firstReview = page.locator('[data-review="0"]');
  await firstReview.click();
  const candidateDialog = page.getByRole('dialog', {name: '找到的是同一篇文献吗？'});
  await expect(candidateDialog).toBeVisible();
  await assertAccessible(page);
  await attachScreenshot(page, testInfo, 'candidate-review');
  await candidateDialog.getByRole('button', {name: '确认使用', exact: true}).click();
  await expect(firstReview).toBeFocused();

  const highFilter = page.getByRole('button', {name: '高匹配', exact: true});
  await highFilter.click();
  const secondCheckbox = page.getByRole('checkbox', {name: `确认匹配：${secondPaper.title}`, exact: true});
  await secondCheckbox.focus();
  await page.keyboard.press('Space');
  await expect(secondCheckbox).toHaveCount(0);
  await expect(highFilter).toBeFocused();

  await page.getByRole('button', {name: '全部', exact: true}).click();
  await secondCheckbox.uncheck();
  await highFilter.click();
  const secondReview = page.locator('[data-review="1"]');
  await secondReview.click();
  await page.keyboard.press('Escape');
  await expect(secondReview).toBeFocused();
  await secondReview.click();
  await candidateDialog.getByRole('button', {name: '确认使用', exact: true}).click();
  await expect(secondReview).toHaveCount(0);
  await expect(highFilter).toBeFocused();
  await expect(highFilter).toHaveAttribute('aria-pressed', 'true');
});

test('pause preserves completed work, resume queries the remainder, and failed rows retry', async ({page, crossref}) => {
  let secondCalls = 0;
  let releasePending;
  let markPending;
  const pending = new Promise(resolve => { markPending = resolve; });
  const released = new Promise(resolve => { releasePending = resolve; });
  crossref.respond = async url => {
    if (url.searchParams.get('query.bibliographic').startsWith(paper.title)) return responseFor(paper);
    secondCalls++;
    if (secondCalls === 1) {
      markPending();
      await released;
    }
    if (secondCalls === 2) return {status: 403, json: {message: 'Offline test: access denied'}};
    return responseFor(secondPaper, '10.5555/accessible-tools');
  };
  await page.goto('/');
  await importItems(page, [paper, secondPaper]);
  await page.getByRole('button', {name: '开始批量查询'}).click();
  await pending;
  await page.getByRole('button', {name: '暂停查询'}).click();
  await expect(page.locator('#progress-text')).toHaveText('已暂停 · 保留已完成的 1 条查询');
  releasePending();
  await expect(page.locator('#stat-high')).toHaveText('1');
  await expect(page.locator('#result-rows tr').nth(1)).toContainText('待查询');

  await page.getByRole('button', {name: '继续批量查询'}).click();
  await expect(page.locator('#progress-text')).toHaveText('本批查询完成 · 1 条');
  await expect(page.locator('#result-rows tr').nth(1)).toContainText('查询失败');
  await expect(page.locator('#result-rows tr').nth(1)).toContainText('Crossref 拒绝请求');
  await page.getByRole('button', {name: '重试', exact: true}).click();
  await expect(page.locator('#stat-high')).toHaveText('2');
  await expect(page.getByRole('button', {name: '查询已完成'})).toBeDisabled();
  expect(crossref.requests.filter(url => url.searchParams.get('query.bibliographic').startsWith(paper.title))).toHaveLength(1);
  expect(secondCalls).toBe(3);
});

test('local Worker serves security headers, JavaScript MIME, and a real 404', async ({page, request}, testInfo) => {
  const home = await page.goto('/');
  expect(home.status()).toBe(200);
  expect(home.headers()['x-content-type-options']).toBe('nosniff');
  expect(home.headers()['x-frame-options']).toBe('DENY');
  expect(home.headers()['content-security-policy']).toContain("connect-src 'self' https://api.crossref.org");
  const moduleResponse = await request.get('/app.mjs');
  expect(moduleResponse.status()).toBe(200);
  expect(moduleResponse.headers()['content-type']).toMatch(/(?:text|application)\/javascript/);

  const missing = await page.goto('/this-page-does-not-exist');
  expect(missing.status()).toBe(404);
  await expect(page).toHaveTitle('页面不存在 · title2doi');
  await expect(page.getByRole('link', {name: '返回工作台 →'})).toHaveAttribute('href', '/');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  await assertAccessible(page);
  await attachScreenshot(page, testInfo, 'not-found-page');
});
