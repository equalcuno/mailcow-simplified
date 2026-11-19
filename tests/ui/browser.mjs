/** Full browser regression checks against local fixtures. Never uses a mail server. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { startPreview } from './preview.mjs';

const { default: puppeteer } = await import(process.env.PUPPETEER_MODULE ? pathToFileURL(process.env.PUPPETEER_MODULE).href : 'puppeteer');
const output = process.env.PLATES_PREVIEW_DIR || join(tmpdir(), 'mailcow-plates-preview');
await mkdir(output, { recursive: true });
const preview = await startPreview();
let browser;
const failures = [];
try {
  browser = await puppeteer.launch({ headless: true, ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}), args: process.env.CI ? ['--no-sandbox'] : [] });
  const page = await browser.newPage();
  await page.setCookie({ url: preview.url, name: 'mailcow_components', value: 'original' });
  page.on('pageerror', error => failures.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', request => {
    // All test traffic stays on this ephemeral local fixture server.
    if (new URL(request.url()).origin === preview.url || request.url().startsWith('data:')) request.continue();
    else request.abort();
  });
  const ready = async () => {
    await page.waitForSelector('#mail-content.plates-mail-ready');
    await page.waitForFunction(() => document.querySelector('#tab-mailboxes')?.classList.contains('active'));
    await page.waitForSelector('#mailbox_table tbody tr td');
    await page.evaluate(() => document.fonts.ready);
  };
  for (const width of [1440, 390, 768, 1920]) {
    await page.setViewport({ width, height: 960, deviceScaleFactor: 1 });
    await page.goto(preview.url + '/admin/mailbox#tab-mailboxes', { waitUntil: 'networkidle0' });
    await ready();
    assert.ok(await page.evaluate(async () => {
      const faces = await document.fonts.load('16px "bootstrap-icons"');
      return faces.length > 0 && faces.every(face => face.status === 'loaded');
    }), 'Bootstrap icon font is declared and loads successfully');
    assert.equal(await page.$eval('[data-plates-title]', el => el.textContent), 'Mailboxes');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `No page overflow at ${width}px`);
    await page.screenshot({ path: join(output, `mailboxes-${width}.png`), fullPage: true });
    if (width < 992) {
      await page.click('.plates-menu');
      await page.waitForSelector('#plates-navigation.show');
      await page.screenshot({ path: join(output, `navigation-${width}.png`) });
      await page.click('.plates-rail [data-plates-tab="tab-domains"]');
      await page.waitForFunction(() => document.querySelector('#tab-domains').classList.contains('active') && !document.querySelector('#plates-navigation').classList.contains('show'));
    } else {
      await page.click('.plates-rail [data-plates-tab="tab-domains"]');
      await page.waitForFunction(() => document.querySelector('#tab-domains').classList.contains('active'));
    }
    assert.equal(new URL(page.url()).hash, '#tab-domains');
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('#tab-mailboxes').classList.contains('active'));
  }
  await page.setViewport({ width: 1440, height: 960 });
  await page.select('[data-plates-domain]', 'studio.co.za');
  await page.waitForFunction(() => document.querySelector('#mailbox_table tbody')?.textContent.includes('ops@studio.co.za') && !document.querySelector('#mailbox_table tbody')?.textContent.includes('alex@example.org'));
  await page.click('[data-plates-clear-domain]');
  await page.waitForFunction(() => document.querySelector('#mailbox_table tbody')?.textContent.includes('alex@example.org'));
  await page.click('.plates-primary-action [data-bs-target="#addMailboxModal"]');
  await page.waitForSelector('#addMailboxModal.show');
  await page.screenshot({ path: join(output, 'add-mailbox.png') });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#addMailboxModal').classList.contains('show'));
  await page.click('#dark-mode-toggle');
  await page.waitForSelector('#dark-mode-theme');
  await page.screenshot({ path: join(output, 'mailboxes-dark.png'), fullPage: true });
  await page.click('#dark-mode-toggle');

  await page.goto(preview.url + '/edit/mailbox/alex%40example.org', { waitUntil: 'networkidle0' });
  await page.waitForSelector('form[data-id="editmailbox"] input[name="csrf_token"]');
  await page.$eval('form[data-id="editmailbox"] input[name="name"]', el => { el.value = 'Alex Updated'; });
  const write = page.waitForRequest(request => request.url().endsWith('/api/v1/edit/mailbox') && request.method() === 'POST');
  await page.click('button[data-id="editmailbox"][data-api-url="edit/mailbox"]');
  const request = await write;
  const payload = new URLSearchParams(request.postData());
  assert.equal(payload.get('csrf_token'), 'fixture-csrf-token');
  assert.equal(JSON.parse(payload.get('attr')).name, 'Alex Updated');
  assert.deepEqual(JSON.parse(payload.get('items')), ['alex@example.org']);

  await page.goto(preview.url + '/domainadmin/mailbox#tab-mailboxes', { waitUntil: 'networkidle0' });
  await ready();
  assert.equal(await page.$('.plates-rail a[href="/admin/system"]'), null);
  assert.equal(await page.$('.plates-mail-tabs [data-bs-target="#tab-tls-policy"]'), null);
  await page.goto(preview.url + '/admin/mailbox?ui=stock', { waitUntil: 'networkidle0' });
  assert.equal(await page.$('body.plates-ui'), null);
  assert.equal(await page.$('#plates-navigation'), null);
  await page.goto(preview.url + '/admin/mailbox?ui=plates#tab-mailboxes', { waitUntil: 'networkidle0' });
  await ready();
  await page.goto(preview.url + '/', { waitUntil: 'networkidle0' });
  assert.equal(await page.$('#plates-navigation'), null);
  await page.screenshot({ path: join(output, 'login.png'), fullPage: true });
  // New components run against the same real browser and isolated API fixture.
  await page.setCookie({ url: preview.url, name: 'mailcow_components', value: 'redesigned' });
  for (const width of [390, 1440]) {
    await page.setViewport({ width, height: 844 });
    await page.goto(preview.url + '/admin/mailbox#tab-mailboxes', { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-p-results][aria-busy="false"] .p-data-row');
    assert.equal(await page.$eval('[data-p-advanced]', element => element.open), false, 'Core deep links do not auto-open legacy advanced panels');
    assert.equal(await page.$eval('[data-p-title]', el => el.textContent), 'Mailboxes');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: join(output, `redesigned-mailboxes-${width}.png`), fullPage: true });
    await page.click('[data-p-create]');
    await page.waitForSelector('#p-create-mailbox[open]');
    await page.screenshot({ path: join(output, `redesigned-create-${width}.png`) });
    await page.keyboard.press('Escape');
  }
  await page.goto(preview.url + '/admin/dashboard', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('[data-p-metric="sent_messages"]')?.textContent === '220');
  await page.screenshot({ path: join(output, 'redesigned-overview.png'), fullPage: true });
  await page.goto(preview.url + '/admin/system#tab-ui', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#tab-ui.active');
  assert.ok(await page.$('#tab-ui input[name="ui_favicon"]'));
  await page.screenshot({ path: join(output, 'ui-settings.png'), fullPage: true });
  for (const [width, height] of [[1440, 900], [390, 844], [375, 667]]) {
    await page.setViewport({ width, height });
    await page.goto(preview.url + '/admin', { waitUntil: 'networkidle0' });
    assert.ok(await page.$('button#fido2-login'));
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1 && document.body.scrollHeight <= innerHeight + 1), 'Login has no page scroll');
    await page.screenshot({ path: join(output, `redesigned-login-${width}-${height}.png`) });
  }
  assert.deepEqual(failures, [], 'No browser JavaScript errors');
  console.log(`Plates browser checks passed. Screenshots: ${output}`);
} finally {
  await browser?.close();
  await new Promise(resolve => preview.server.close(resolve));
}
