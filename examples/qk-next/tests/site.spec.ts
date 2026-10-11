import { expect, test, type Locator, type Page } from '@playwright/test';

const SEEDED_TITLES: readonly string[] = [
  'Write docs',
  'Ship alpha',
  'Fix bugs',
  'Publish'
];

/**
 * Wait until PGlite has seeded the task table and the search card is on screen.
 *
 * @param page - Open demo page
 */
async function loadHome(page: Page): Promise<void> {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'QueryKit', exact: true })
  ).toBeVisible();
  await expect(
    page.getByPlaceholder('Search QueryKit with key:value')
  ).toBeVisible();
  await expect(page.getByText('Initializing Database...')).toHaveCount(0);
  await expect(page.getByText('4 of 4')).toBeVisible();
  await expect(page.getByText('Client fallback', { exact: true })).toBeVisible();
}

/**
 * Read the SQL the page is showing, with highlighter whitespace collapsed.
 *
 * @param page - Open demo page
 * @returns Visible SQL text
 */
async function readSql(page: Page): Promise<string> {
  const block: Locator = page.locator('code.language-sql').first();
  await expect(block).toBeVisible();
  const text: string = await block.innerText();
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Type a query and press Enter, the same path as the search box.
 *
 * @param page - Open demo page
 * @param query - QueryKit string to run
 */
async function runQuery(page: Page, query: string): Promise<void> {
  const input: Locator = page.getByPlaceholder('Search QueryKit with key:value');
  await input.click();
  await input.fill(query);
  await expect(input).toHaveValue(query);
  await input.press('Enter');
}

/**
 * Open the results drawer the way a user would.
 *
 * @param page - Open demo page
 * @returns The results dialog
 */
async function showResults(page: Page): Promise<Locator> {
  const toggle: Locator = page.locator('button[aria-controls="results-drawer"]');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return page.getByRole('dialog', { name: 'Query results' });
}

test('loads the production home page with the seeded tasks', async ({
  page
}) => {
  await loadHome(page);
  const sql: string = await readSql(page);
  expect(sql).toBe('SELECT * FROM tasks');
  expect(sql).not.toContain('WHERE');
  const results: Locator = await showResults(page);
  for (const title of SEEDED_TITLES) {
    await expect(results.getByRole('cell', { name: title, exact: true })).toBeVisible();
  }
  await expect(results.getByText('4 rows')).toBeVisible();
});

test('a field query changes the rows, the SQL, and the engine badge', async ({
  page
}) => {
  await loadHome(page);
  await runQuery(page, 'status:done');
  await expect.poll(async () => readSql(page)).toContain('"status" = \'done\'');
  const sql: string = await readSql(page);
  expect(sql).toContain('WHERE');
  expect(sql).not.toBe('SELECT * FROM tasks');
  await expect(page.getByText('1 of 4')).toBeVisible();
  await expect(
    page.getByText('QueryKit · Drizzle', { exact: true })
  ).toBeVisible();
  await expect(page.getByText('Client fallback', { exact: true })).toHaveCount(0);
  const results: Locator = await showResults(page);
  await expect(results.getByRole('cell', { name: 'Publish', exact: true })).toBeVisible();
  await expect(results.getByRole('cell', { name: 'Write docs', exact: true })).toHaveCount(0);
  await expect(results.getByRole('cell', { name: 'Ship alpha', exact: true })).toHaveCount(0);
  await expect(results.getByRole('cell', { name: 'Fix bugs', exact: true })).toHaveCount(0);
  await expect(results.getByText('1 rows')).toBeVisible();
});

test('a regex query is rejected and the engine stays on the client fallback', async ({
  page
}) => {
  await loadHome(page);
  await runQuery(page, 'title:/Ship.*/');
  await expect.poll(async () => readSql(page)).toContain('ILIKE');
  const sql: string = await readSql(page);
  expect(sql).toContain('title:/Ship.*/');
  expect(sql).not.toContain('"title" =');
  await expect(page.getByText('0 of 4')).toBeVisible();
  await expect(page.getByText('Client fallback', { exact: true })).toBeVisible();
  await expect(page.getByText('QueryKit · Drizzle', { exact: true })).toHaveCount(0);
  const results: Locator = await showResults(page);
  await expect(results.getByText('0 rows')).toBeVisible();
  for (const title of SEEDED_TITLES) {
    await expect(results.getByRole('cell', { name: title, exact: true })).toHaveCount(0);
  }
});
