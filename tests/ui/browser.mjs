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
    // Domain icons are synthetic fixtures; all other traffic stays local.
    const url = new URL(request.url());
    if (['example.org', 'studio.co.za'].includes(url.hostname) && /^\/favicon\.(svg|ico|png)$/.test(url.pathname)) {
      if (url.hostname === 'studio.co.za' && url.pathname.endsWith('.svg')) return request.respond({ status: 404, body: '' });
      return request.respond({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#1f4fd8"/><path d="M10 9h13v4h-9v3h7v4h-7v3h9v4H10z" fill="white"/></svg>' });
    }
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
  await page.reload({ waitUntil: 'networkidle0' }); await ready();
  assert.equal(await page.$eval('[data-plates-domain]', el => el.value), 'studio.co.za', 'Domain scope survives a real reload');
  await page.waitForFunction(() => document.querySelector('#mailbox_table tbody')?.textContent.includes('ops@studio.co.za') && !document.querySelector('#mailbox_table tbody')?.textContent.includes('alex@example.org'));
  await page.click('[data-plates-clear-domain]');
  await page.waitForFunction(() => document.querySelector('#mailbox_table tbody')?.textContent.includes('alex@example.org'));
  await page.click('.plates-primary-action [data-bs-target="#addMailboxModal"]');
  await page.waitForSelector('#addMailboxModal.show');
  await page.screenshot({ path: join(output, 'add-mailbox.png') });
  await page.waitForFunction(() => document.activeElement?.closest('#addMailboxModal'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#addMailboxModal').classList.contains('show'));
  await page.click('#dark-mode-toggle');
  await page.waitForSelector('#dark-mode-theme');
  await page.screenshot({ path: join(output, 'mailboxes-dark.png'), fullPage: true });
  await page.click('#dark-mode-toggle');

  await page.goto(preview.url + '/edit/mailbox/alex%40example.org', { waitUntil: 'networkidle0' });
  await page.waitForSelector('form[data-id="editmailbox"] input[name="csrf_token"]');
  await page.$eval('form[data-id="editmailbox"] input[name="name"]', el => { el.value = 'Alex Updated'; });
  await page.$eval('button[data-id="editmailbox"][data-api-url="edit/mailbox"]', el => el.setAttribute('data-api-reload-window', 'false'));
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
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.evaluate(() => localStorage.setItem('mailcow_theme', 'light'));
  for (const width of [390, 1440]) {
    await page.setViewport({ width, height: 844 });
    await page.goto(preview.url + '/admin/mailbox?viewport=' + width + '#tab-mailboxes', { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-p-results][aria-busy="false"] .p-data-row');
    assert.equal(await page.$eval('[data-p-advanced]', element => element.open), false, 'Core deep links do not auto-open legacy advanced panels');
    assert.equal(await page.$eval('[data-p-title]', el => el.textContent), 'Mailboxes');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: join(output, `redesigned-mailboxes-${width}.png`), fullPage: true });
    await page.click('[data-p-create]');
    await page.waitForSelector('#p-create-mailbox[open]');
    await page.click('#p-create-mailbox [data-p-bulk-create] > summary');
    await page.type('[data-p-bulk-input]', 'first, First User\nsecond, Second User');
    await page.click('[data-p-bulk-preview]');
    assert.equal(await page.$$eval('.p-bulk-row input', inputs => inputs.filter(({ value }) => value.length >= 32 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && /[^a-zA-Z\d]/.test(value)).length), 2, await page.$eval('[data-p-bulk-status]', el => el.textContent));
    assert.ok(await page.evaluate(() => document.querySelector('#p-create-mailbox').scrollWidth <= document.querySelector('#p-create-mailbox').clientWidth + 1), 'Bulk form fits its dialog on mobile');
    await page.screenshot({ path: join(output, `redesigned-create-${width}.png`) });
    await page.$eval('.p-bulk-row input', input => { input.value = 'short'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.ok(await page.$eval('.p-bulk-row', row => row.textContent.includes('minimum 16')));
    await page.$eval('#p-create-mailbox', dialog => { dialog.scrollTop = dialog.scrollHeight; });
    await page.screenshot({ path: join(output, `mailbox-validation-${width}.png`) });
    await page.keyboard.press('Escape');
    await page.click('.p-list-toolbar [data-p-task="tab-domains"]');
    await page.waitForFunction(() => document.querySelector('[data-p-domain-name]')?.textContent === 'Setup needed');
    assert.ok(await page.$('.p-row-actions .p-domain-setup-link + .p-row-open'), 'DNS button is next to the arrow');
    if (width === 1440) {
      await page.waitForSelector('.p-domain-icon-loaded img');
      assert.ok(await page.$$eval('.p-row-icon img', images => images.some(image => image.currentSrc.endsWith('/favicon.ico'))), 'Favicon fallback renders in the browser');
    }
    await page.screenshot({ path: join(output, `domain-status-${width}.png`), fullPage: true });
    await page.click('.p-domain-setup-link');
    await page.waitForSelector('[data-p-domain-setup][open] .p-dns-table');
    assert.ok(await page.$eval('[data-p-setup-summary]', el => el.textContent.includes('3 / 6 required checks')));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Domain setup has no page overflow');
    assert.ok(await page.$eval('[data-p-domain-setup]', dialog => dialog.scrollWidth <= dialog.clientWidth + 1), 'Long DKIM values stay inside the setup dialog');
    if (width === 1440) assert.ok(await page.$eval('.p-dns-table', table => table.scrollWidth <= table.clientWidth + 1), 'All DNS columns fit the desktop panel');
    await page.screenshot({ path: join(output, `domain-setup-${width}.png`) });
    if (width === 1440) {
      await page.evaluate(() => document.getElementById('dark-mode-toggle').click());
      await page.waitForSelector('html[data-plates-dark]');
      await page.screenshot({ path: join(output, 'domain-setup-dark.png') });
      await page.evaluate(() => document.getElementById('dark-mode-toggle').click());
    }
    await page.click('[data-p-setup-refresh]');
    await page.waitForSelector('[data-p-setup-records][aria-busy="false"] .p-dns-table');
    await page.keyboard.press('Escape');
  }
  await page.goto(preview.url + '/admin/dashboard', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('[data-p-metric="sent_messages"]')?.textContent === '220');
  await page.waitForFunction(() => document.querySelector('[data-p-host-chart="cpu"]')?.getAttribute('aria-label')?.includes('7 measured samples'), { timeout: 40000 });
  assert.ok(await page.$('[data-p-host-chart="cpu"] path[stroke]'), 'Live graph connects actual polled samples');
  await page.screenshot({ path: join(output, 'redesigned-overview.png'), fullPage: true });
  await page.setViewport({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Live charts fit mobile');
  await page.screenshot({ path: join(output, 'overview-live-390.png'), fullPage: true });
  await page.setViewport({ width: 1440, height: 960 });
  await page.evaluate(() => document.getElementById('dark-mode-toggle').click());
  await page.waitForSelector('html[data-plates-dark]');
  await page.waitForFunction(() => document.getElementById('dark-mode-theme')?.sheet);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-p-overview-refresh]')).backgroundColor === 'rgb(37, 50, 63)');
  await page.screenshot({ path: join(output, 'overview-live-dark.png') });
  await page.goto(preview.url + '/admin/system#tab-ui', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#tab-ui.active');
  assert.ok(await page.$('#tab-ui input[name="ui_favicon"]'));
  const palette = await page.evaluate(() => {
    const style = selector => getComputedStyle(document.querySelector(selector));
    return { input: style('[name="business_name"]').borderTopColor, divider: style('.p-branding-settings').borderLeftColor, label: style('.p-preferences label:not(:has(input:checked))').borderTopColor, primary: style('.p-branding-settings .btn-primary').backgroundColor };
  });
  assert.deepEqual(palette, { input: 'rgb(52, 66, 81)', divider: 'rgb(52, 66, 81)', label: 'rgb(52, 66, 81)', primary: 'rgb(31, 79, 216)' }, 'Appearance controls use the dark palette with a readable primary button');
  await page.screenshot({ path: join(output, 'appearance-dark.png'), fullPage: true });
  // System tabs use button dropdowns in current upstream templates.
  const accessSelector = await page.evaluate(() => {
    const item = [...document.querySelectorAll('[data-bs-toggle="dropdown"]')].find(element => element.textContent.trim() === 'Access');
    if (!item) return null;
    item.id = 'fixture-access-menu'; return '#fixture-access-menu';
  });
  assert.ok(accessSelector, 'Access dropdown is present');
  await page.click(accessSelector);
  await page.waitForSelector('.dropdown-menu.show');
  assert.equal(await page.$eval('.dropdown-menu.show', menu => getComputedStyle(menu).backgroundColor), 'rgb(27, 38, 50)', 'Access menu uses the dark surface');
  await page.screenshot({ path: join(output, 'access-dropdown-dark.png') });
  await page.keyboard.press('Escape');
  await page.setCookie({ url: preview.url, name: 'mailcow_components', value: 'original' });
  await page.setViewport({ width: 1440, height: 1200 });
  await page.goto(preview.url + '/admin/mailbox#tab-domains', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#domain_table tbody tr td');
  await page.waitForFunction(() => [...document.querySelectorAll('#domain_table tbody td')].some(cell => cell.textContent.includes('example.org') && cell.getBoundingClientRect().width > 10));
  const darkTable = await page.evaluate(() => ({ row: getComputedStyle(document.querySelector('#domain_table tbody tr')).backgroundColor, input: getComputedStyle(document.querySelector('#domain_table_filter input')).backgroundColor }));
  assert.ok(['rgb(27, 38, 50)', 'rgb(37, 50, 63)'].includes(darkTable.row), 'Advanced table rows use the Plates dark palette');
  assert.equal(darkTable.input, 'rgb(17, 25, 34)', 'Advanced search uses the dark input surface');
  // Full-page capture briefly changes Chrome's viewport and confuses upstream
  // DataTables Responsive; a tall fixed viewport preserves its real layout.
  await page.screenshot({ path: join(output, 'advanced-domains-dark.png') });
  assert.ok(await page.$eval('#domain_table tbody', body => [...body.querySelectorAll('td')].some(cell => cell.textContent === 'example.org' && cell.offsetWidth > 0)), 'Domain columns stay visible during capture');
  await page.setCookie({ url: preview.url, name: 'mailcow_components', value: 'redesigned' });
  await page.evaluate(() => document.getElementById('dark-mode-toggle').click());
  await page.goto(preview.url + '/admin/system#tab-ui', { waitUntil: 'networkidle0' });
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
