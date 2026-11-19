/** Exercise the real adapter and Bootstrap in a DOM, without a browser or sockets. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const { Window } = await import(process.env.HAPPY_DOM_MODULE ? pathToFileURL(process.env.HAPPY_DOM_MODULE).href : 'happy-dom');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.env.PLATES_PREVIEW_DIR || join(tmpdir(), 'mailcow-plates-preview');
const read = path => readFile(join(root, path), 'utf8');
const jquery = await read('data/web/js/build/000-jquery-3.6.0.min.js');
const bootstrap = await read('data/web/js/build/001-bootstrap.bundle.min.js');
const adapter = await read('data/web/ui/plates/assets/plates.js');
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks++; }

async function fixture(name, path, role = 'admin') {
  const window = new Window({ url: 'http://localhost' + path, settings: { enableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  // Execute only the files under test; fixture inline handlers remain covered by browser.mjs.
  const html = (await readFile(join(output, name + '.html'), 'utf8')).replace(/<script\b(?![^>]*type="application\/json")[^>]*>[\s\S]*?<\/script>/gi, '');
  window.document.write(html);
  window.document.close();
  const originalTabs = [...window.document.querySelectorAll('#mail-content > [role="tablist"] [data-bs-toggle="tab"]')].map(button => button.dataset.bsTarget).sort();
  window.eval(jquery);
  window.eval(bootstrap);
  window.role = role;
  const requests = [];
  window.jQuery.ajaxTransport('+*', options => ({
    send(headers, complete) { requests.push(options); complete(200, 'OK', { text: '{}' }, 'Content-Type: application/json'); },
    abort() {},
  }));
  window.eval(adapter);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await pause();
  await pause();
  return { window, document: window.document, requests, originalTabs, $: window.jQuery };
}

const admin = await fixture('admin-original', '/admin/mailbox#tab-mailboxes');
try {
  const { window, document, $, requests } = admin;
  check(document.querySelector('#mail-content').classList.contains('plates-mail-ready'), 'Adapter initializes');
  check(document.querySelector('#tab-mailboxes').classList.contains('active'), 'Direct mailbox link overrides remembered/default tab');
  check(document.querySelector('[data-plates-title]').textContent === 'Mailboxes', 'Page title follows the current task');
  check(document.querySelector('.plates-primary-action [data-bs-target="#addMailboxModal"]'), 'Mailbox creation is exposed as the primary action');
  check(document.querySelectorAll('.plates-mail-tabs > .nav-item').length === 4, 'Three daily tasks plus More tools');
  check(JSON.stringify([...document.querySelectorAll('.plates-mail-tabs [data-bs-toggle="tab"]')].map(button => button.dataset.bsTarget).sort()) === JSON.stringify(admin.originalTabs), 'Every administrator tab survives regrouping');
  check(document.querySelector('#plates-main').getAttribute('role') === 'main', 'Skip target is the actual content');
  check(!document.querySelector('[data-plates-domain-filter]').hidden, 'Domain scope is available for mailboxes');
  check(document.querySelector('.plates-rail [data-plates-tab="tab-mailboxes"]').getAttribute('aria-current') === 'page', 'Rail selection follows the tab');
  const domain = document.querySelector('[data-plates-domain]');
  domain.value = 'studio.co.za';
  domain.dispatchEvent(new window.Event('change'));
  await $.ajax({ url: '/api/v1/search/mailbox', type: 'POST', contentType: 'application/json', data: JSON.stringify({ draw: 1, search: { value: 'ops' } }) });
  const request = JSON.parse(requests.at(-1).data);
  check(request.domain === 'studio.co.za' && request.search.value === 'ops', 'Domain scope composes with the original JSON table request');
  document.querySelector('[data-plates-clear-domain]').click();
  await $.ajax({ url: '/api/v1/search/mailbox', type: 'POST', contentType: 'application/json', data: '{"draw":2}' });
  check(!('domain' in JSON.parse(requests.at(-1).data)), 'Clearing the domain restores the original request scope');
  document.querySelector('.plates-rail [data-plates-tab="tab-domains"]').click();
  await pause();
  check(document.querySelector('#tab-domains').classList.contains('active'), 'Rail navigation opens the native domain tab');
  check(window.location.hash === '#tab-domains', 'Tab navigation updates browser history');
  check(document.querySelector('[data-plates-domain-filter]').hidden, 'Mailbox filter stays out of other tasks');
  window.history.back();
  await pause();
  check(document.querySelector('#tab-mailboxes').classList.contains('active'), 'Back restores the previous task');
  document.querySelector('[data-bs-target="#tab-templates-domains"]').click();
  await pause();
  check(document.querySelector('.plates-mail-tabs > .dropdown > .dropdown-toggle').classList.contains('active'), 'More tools marks its selected advanced tab');
  document.querySelector('.plates-menu').click();
  await pause();
  check(document.querySelector('#plates-navigation').classList.contains('show'), 'Mobile navigation opens with native Bootstrap offcanvas');
  document.querySelector('#plates-navigation [data-bs-dismiss="offcanvas"]').click();
  await pause();
  check(!document.querySelector('#plates-navigation').classList.contains('show'), 'Mobile navigation closes');
} finally { await admin.window.happyDOM.close(); }

const manager = await fixture('domainadmin-original', '/domainadmin/mailbox#tab-mailboxes', 'domainadmin');
try {
  check(!manager.document.querySelector('.plates-mail-tabs [data-bs-target="#tab-tls-policy"]'), 'Admin-only TLS tools stay out of domain-admin navigation');
  check(!manager.document.querySelector('.plates-mail-tabs [data-bs-target="#tab-templates-domains"]'), 'Administrator templates stay out of domain-admin navigation');
  check(manager.document.querySelector('#tab-mailboxes').classList.contains('active'), 'Domain-admin mailbox deep link works');
} finally { await manager.window.happyDOM.close(); }

const stock = await fixture('stock', '/admin/mailbox');
try {
  check(!stock.document.querySelector('.plates-mail-ready'), 'Classic mode bypasses the adapter');
} finally { await stock.window.happyDOM.close(); }

// Exercise the unchanged mailcow write handler with the inherited edit form.
const edit = await fixture('edit-original', '/edit/mailbox/alex%40example.org');
try {
  const { window, document, requests } = edit;
  window.lang_footer = { loading: 'Saving' };
  window.csrf_token = 'fixture-csrf-token';
  window.eval(await read('data/web/js/build/003-bootstrap-select.js'));
  window.eval(await read('data/web/js/build/006-formcache.min.js'));
  window.eval(await read('data/web/js/build/011-api.js'));
  await pause();
  const form = document.querySelector('form[data-id="editmailbox"]');
  window.jQuery(form).find('select[name="authsource"]').val('mailcow');
  form.querySelector('input[name="name"]').value = 'Alex Updated';
  const save = form.querySelector('[data-action="edit_selected"][data-api-url="edit/mailbox"]');
  save.setAttribute('data-api-reload-window', 'false');
  save.click();
  await pause();
  const captured = requests.find(item => item.url === '/api/v1/edit/mailbox');
  check(captured, 'Inherited edit form invokes the real mailcow API handler; invalid fields: ' + [...form.querySelectorAll('.inputMissingAttr')].map(el => el.name).join(', '));
  const payload = new URLSearchParams(captured.data);
  check(payload.get('csrf_token') === 'fixture-csrf-token', 'Native save retains CSRF protection');
  check(JSON.parse(payload.get('attr')).name === 'Alex Updated', 'Native save serializes edited values');
  check(JSON.parse(payload.get('items'))[0] === 'alex@example.org', 'Native save targets the selected mailbox');
} finally { await edit.window.happyDOM.close(); }
console.log(`Plates: ${checks} DOM interaction checks passed.`);
