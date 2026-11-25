/** Interaction checks for purpose-built components and the Settings → UI tab. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
const { Window } = await import(process.env.HAPPY_DOM_MODULE ? pathToFileURL(process.env.HAPPY_DOM_MODULE).href : 'happy-dom');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.env.PLATES_PREVIEW_DIR || join(tmpdir(), 'mailcow-plates-preview');
const file = name => readFile(join(root, name), 'utf8');
const pause = () => new Promise(resolve => setTimeout(resolve, 70));
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const strongPassword = value => value.length >= 32 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && /[^a-zA-Z\d]/.test(value);

async function open(name, path, options = {}) {
  const window = new Window({ url: 'http://localhost' + path, settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  const html = (await readFile(join(output, name + '.html'), 'utf8')).replace(/<script\b(?![^>]*type="application\/json")[^>]*>[\s\S]*?<\/script>/gi, '');
  window.document.write(html); window.document.close();
  const requests = [], errors = [];
  const batchResponse = options.batchResponse;
  const setupResponse = options.setupResponse;
  const serverResponse = options.serverResponse;
  const timers = new Map(); let timerId = -1;
  if (options.controlTimers) {
    const nativeTimeout = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => {
      if ([5000, 60000].includes(delay)) { const id = timerId--; timers.set(id, { callback, delay, args }); return id; }
      return nativeTimeout(callback, delay, ...args);
    };
    window.clearTimeout = id => { timers.delete(id); nativeClear(id); };
  }
  for (const [key, value] of Object.entries(options.storage || {})) window.localStorage.setItem(key, value);
  window.csrf_token = 'fixture-csrf-token';
  let updateBusy = false;
  let aliasData = [{ address: 'team@example.org', id: 5, goto: 'alex@example.org', active: 1 }];
  window.addEventListener('error', event => errors.push(event.message));
  window.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === '/server-update.php') {
      if (options.method === 'POST') updateBusy = true;
      return { ok: true, json: async () => ({ ready: !updateBusy, busy: updateBusy, candidate: 'a'.repeat(40), csrf_token: 'update-csrf', message: updateBusy ? 'Update queued' : 'Update available' }) };
    }
    if (url === '/mailbox-batch.php') return batchResponse ? batchResponse(JSON.parse(options.body)) : { ok: true, json: async () => ({ csrf_token: 'rotated-csrf', results: JSON.parse(options.body).rows.map((row, i) => ({ address: row.local_part + '@' + row.domain, created: i === 0, message: i === 0 ? 'Created' : 'Already exists' })) }) };
    if (url.startsWith('/inc/ajax/dns_diagnostics.php?')) {
      const domain = new URL(url, window.location.href).searchParams.get('domain');
      return setupResponse ? setupResponse(url, domain) : { ok: true, json: async () => ({ domain, enabled: true, ready: false, required: 1, complete: 0, checked_at: 123, records: [{ name: domain, type: 'MX', expected: 'mail.example.org', current: [], required: true, status: 'missing' }] }) };
    }
    if (url === '/api/v1/get/overview/server' && serverResponse) return serverResponse();
    if (url === '/api/v1/get/overview' || url === '/api/v1/get/overview/server') return { ok: true, json: async () => {
      const data = JSON.parse(await readFile(join(output, 'overview.json'), 'utf8'));
      data.generated_at = Math.floor(Date.now() / 1000); data.server.sampled_at = Date.now() / 1000;
      return data;
    } };
    let data = [];
    const body = JSON.parse(options.body || '{}');
    if (url.endsWith('/domain')) data = { recordsFiltered: 1, data: [{ domain_name: 'example.org', domain_h_name: 'example.org', description: 'Business mail', active: 1, mboxes_in_domain: 2, quota_used_in_domain: '2 GiB' }] };
    if (url.endsWith('/mailbox')) {
      const all = [{ username: 'alex@example.org', name: '<img src=x onerror=alert(1)>', domain: 'example.org', active: 1, quota: 1024, quota_used: 512, percent_in_use: 50 }, { username: 'ops@studio.co.za', domain: 'studio.co.za', name: 'Operations', active: 0, quota: 0, quota_used: 100, percent_in_use: 0 }];
      const rows = all.filter(row => (!body.domain || row.domain === body.domain) && (!body.search?.value || row.username.includes(body.search.value)));
      data = { recordsFiltered: rows.length, data: rows };
    }
    if (url.includes('/alias/')) data = aliasData;
    return { ok: true, json: async () => data };
  };
  window.eval(await file('data/web/js/build/000-jquery-3.6.0.min.js'));
  window.eval(await file('data/web/js/build/001-bootstrap.bundle.min.js'));
  window.eval(await file('data/web/ui/plates/assets/preferences.js'));
  window.eval(await file('data/web/ui/plates/assets/plates.js'));
  window.document.documentElement.setAttribute('data-plates-pending', '');
  window.eval(await file('data/web/ui/plates/assets/components.js'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await pause(); await pause();
  return { window, document: window.document, requests, errors, setAliases: value => { aliasData = value; }, timers, runTimer: async delay => {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, 'Expected scheduled timer ' + delay);
    timers.delete(entry[0]); await entry[1].callback(...entry[1].args); await pause();
  } };
}

const mail = await open('admin', '/admin/mailbox#tab-mailboxes');
try {
  const { window, document, requests } = mail;
  check(!document.documentElement.hasAttribute('data-plates-pending'), 'Correct initial view is revealed after selection');
  check(document.querySelector('[data-p-title]').textContent === 'Mailboxes', 'Deep link selects redesigned mailbox view');
  check(window.location.hash === '#mailboxes' && !document.querySelector('[data-p-advanced]').open, 'Core fragments are distinct from legacy panel IDs');
  check(document.querySelectorAll('.p-data-row').length === 2, 'Custom rows render API data');
  check(!document.querySelector('[data-p-results] img'), 'Untrusted row values render as text');
  check(document.querySelector('[data-p-results]').textContent.includes('<img src=x'), 'Names are preserved as literal text');
  const domain = document.querySelector('[data-p-domain]');
  domain.value = 'studio.co.za'; domain.dispatchEvent(new window.Event('change')); await pause();
  check(document.querySelectorAll('.p-data-row').length === 1 && document.querySelector('[data-p-results]').textContent.includes('ops@studio.co.za'), 'Domain scope drives server-side custom list requests');
  check(JSON.parse(requests.at(-1).options.body).domain === 'studio.co.za', 'Domain scope is passed as a bound API field');
  check(document.querySelector('[data-p-create]').classList.contains('btn-primary'), 'Restyled native mailcow buttons are retained');
  document.querySelector('[data-p-create]').click();
  check(document.getElementById('p-create-mailbox').open, 'Creation opens the focused form dialog');
  document.querySelector('#p-create-mailbox [data-p-dialog-close]').click();
  check(!document.getElementById('p-create-mailbox').open, 'Focused form closes');
  document.querySelector('.plates-rail [data-plates-tab="tab-domains"]').click(); await pause();
  check(document.querySelector('[data-p-title]').textContent === 'Domains', 'Sidebar switches redesigned views without a document reload');
  check(document.querySelector('.p-row-actions .p-domain-setup-link + .p-row-open'), 'DNS button sits beside the edit arrow');
  const icon = document.querySelector('.p-row-icon img');
  check(icon.src === 'https://example.org/favicon.svg' && icon.referrerPolicy === 'no-referrer', 'Domain SVG favicon loads without a referrer');
  icon.dispatchEvent(new window.Event('error'));
  check(icon.src === 'https://example.org/favicon.ico', 'Missing SVG falls back to the domain favicon');
  icon.dispatchEvent(new window.Event('error')); icon.dispatchEvent(new window.Event('error'));
  check(!document.querySelector('.p-row-icon img') && document.querySelector('.p-row-icon i'), 'Missing favicons retain the globe');
  document.querySelector('.p-domain-count').click(); await pause();
  check(document.querySelector('[data-p-title]').textContent === 'Mailboxes' && JSON.parse(requests.at(-1).options.body).domain === 'example.org', 'Domain rows lead to their mailbox scope');
  window.history.back(); await pause();
  check(document.querySelector('[data-p-title]').textContent === 'Domains', 'Back restores redesigned views');
  document.querySelector('[data-p-task="tab-mbox-aliases"]').click(); await pause();
  check(document.querySelector('[data-p-results]').textContent.includes('team@example.org'), 'Alias rows use the existing alias endpoint');
  check(document.querySelector('.p-row-title').getAttribute('href') === '/edit/alias/5', 'Alias links target native editing by ID');
  mail.setAliases({});
  document.querySelector('[data-p-refresh]').click(); await pause();
  const copy = JSON.parse(document.getElementById('p-workspace-copy').textContent);
  check(document.querySelector('[data-p-results]').textContent.includes(copy.empty_title), 'Native empty-object alias response renders the empty state');
  mail.setAliases({ type: 'error' });
  document.querySelector('[data-p-refresh]').click(); await pause();
  check(document.querySelector('[data-p-results]').textContent.includes(copy.load_error), 'Malformed alias responses still report an error');
  const writes = [];
  window.csrf_token = 'fixture-csrf-token'; window.lang_footer = { loading: 'Saving' };
  window.eval(await file('data/web/js/build/006-formcache.min.js'));
  window.jQuery.ajaxTransport('+*', options => ({ send(headers, complete) { writes.push(options); complete(200, 'OK', { text: '[]' }, 'Content-Type: application/json'); }, abort() {} }));
  window.eval(await file('data/web/js/build/011-api.js')); await pause();
  document.querySelector('[data-p-create]').click();
  const form = document.querySelector('form[data-id="plates_add_alias"]');
  form.querySelector('[name="address"]').value = '@example.org\nteam@example.business';
  form.querySelector('[name="goto"]').value = 'alex@example.org';
  const submit = form.querySelector('[data-action="add_item"]');
  submit.setAttribute('data-api-reload-window', 'false'); submit.click(); await pause();
  const write = writes.find(request => request.url === '/api/v1/add/alias');
  check(write, 'Catch-all, multiple addresses and long TLDs reach the native alias creation handler');
  const payload = new URLSearchParams(write.data), attr = JSON.parse(payload.get('attr'));
  check(attr.address.replace(/\r\n/g, '\n') === '@example.org\nteam@example.business' && attr.goto === 'alex@example.org', 'Alias creation preserves address and destination values');
  check(attr.active === '1' && attr.internal === '0' && attr.sender_allowed === '1' && attr.sogo_visible === '1', 'Alias creation matches native default flags');
  check(payload.get('csrf_token') === 'fixture-csrf-token', 'Alias creation retains native CSRF protection');
  check(mail.errors.length === 0, 'Workspace interactions have no script errors: ' + mail.errors.join(', '));
} finally { await mail.window.happyDOM.close(); }

const bulk = await open('admin', '/admin/mailbox#mailboxes', { storage: { 'plates:domain:/admin/mailbox:admin': 'studio.co.za' } });
try {
  const { window, document, requests } = bulk;
  check(JSON.parse(requests.find(r => r.url.endsWith('/mailbox')).options.body).domain === 'studio.co.za', 'Saved domain applies before the first inventory request');
  document.querySelector('[data-p-create]').click();
  const dialog = document.getElementById('p-create-mailbox');
  check(dialog.querySelector('[data-p-bulk-domain]').value === 'studio.co.za', 'Create dialog inherits the saved domain');
  dialog.querySelector('[data-p-generate-password]').click();
  const password = dialog.querySelector('[name="password"]').value;
  check(strongPassword(password) && dialog.querySelector('[name="password2"]').value === password, 'Generator supplies matching strong passwords with every native character class');
  const source = dialog.querySelector('[data-p-bulk-input]');
  source.value = 'first, First User\nsecond, Second User';
  dialog.querySelector('[data-p-bulk-preview]').click();
  const secrets = [...dialog.querySelectorAll('.p-bulk-row input')].map(input => input.value);
  check(secrets.length === 2 && secrets.every(strongPassword) && secrets[0] !== secrets[1], 'Bulk review generates an independent strong password for every row');
  check(!requests.some(r => r.url === '/mailbox-batch.php'), 'Review does not create mailboxes');
  dialog.querySelector('[data-p-bulk-submit]').click(); await pause();
  const batch = requests.find(r => r.url === '/mailbox-batch.php');
  const payload = JSON.parse(batch.options.body);
  check(payload.csrf_token === 'fixture-csrf-token' && payload.rows.length === 2 && payload.rows[0].domain === 'studio.co.za', 'Explicit batch submission carries domain scope and CSRF');
  check(window.csrf_token === 'rotated-csrf', 'Batch consumes the rotated CSRF token');
  check(dialog.querySelector('[data-p-bulk-submit]').disabled && !dialog.querySelector('[data-p-bulk-export]').disabled, 'Partial success enables credential export and prevents automatic retries');
  check(dialog.querySelectorAll('.p-bulk-row input:disabled').length === 1, 'Only confirmed created passwords become immutable');
  dialog.querySelector('[data-p-bulk-preview]').click();
  check(dialog.querySelector('.p-bulk-row input').disabled && dialog.querySelector('.p-bulk-row').textContent.includes('Already created'), 'Review preserves previously created rows and their passwords');
  dialog.querySelector('[data-p-bulk-submit]').click(); await pause();
  check(JSON.parse(requests.filter(r => r.url === '/mailbox-batch.php').at(-1).options.body).rows.every(row => row.local_part !== 'first'), 'Another explicit review never submits confirmed successes again');
  source.value = 'third, Third User'; source.dispatchEvent(new window.Event('input'));
  dialog.querySelector('[data-p-bulk-preview]').click();
  check(!dialog.querySelector('[data-p-bulk-export]').disabled, 'Another review preserves prior successful credentials for export');
  source.value = 'foreign@unavailable.example';
  dialog.querySelector('[data-p-bulk-preview]').click();
  check(dialog.querySelector('[data-p-bulk-submit]').disabled && requests.filter(r => r.url === '/mailbox-batch.php').length === 2, 'Unavailable domains fail review without another write');
  dialog.close();
  check(!source.value && dialog.querySelector('[data-p-bulk-export]').disabled, 'Closing clears generated credentials from the dialog');
  check(![...Array(window.localStorage.length)].map((_, i) => window.localStorage.getItem(window.localStorage.key(i))).some(value => value.includes(secrets[0])), 'Generated credentials never enter persistent browser storage');
} finally { await bulk.window.happyDOM.close(); }

for (const scenario of ['mixed', 'rejected', 'network', 'invalid-json', 'server-error']) {
  const fixture = await open('admin', '/admin/mailbox#domains', { batchResponse: async payload => {
    if (scenario === 'network') throw new Error('Network connection lost');
    if (scenario === 'invalid-json') return { ok: false, status: 502, json: async () => { throw new Error('Invalid JSON'); } };
    if (scenario === 'server-error') return { ok: false, status: 500, json: async () => ({ message: 'Server error' }) };
    if (scenario === 'rejected') return { ok: false, status: 422, json: async () => ({ message: 'Invalid mailbox batch.' }) };
    return { ok: true, json: async () => ({ results: payload.rows.map(row => ({ address: row.local_part + '@' + row.domain, created: row.password.length >= 16, message: row.password.length >= 16 ? 'Created' : 'Not created. Password is too short (minimum 16).' })) }) };
  } });
  try {
    const { document } = fixture;
    document.querySelector('[data-p-task="tab-mailboxes"]').click(); await pause();
    document.querySelector('[data-p-create]').click();
    document.querySelector('[data-p-bulk-input]').value = 'short, Short User, weak\nvalid, Valid User';
    document.querySelector('[data-p-bulk-preview]').click();
    check(document.querySelector('.p-bulk-row').textContent.includes('minimum 16'), 'Review identifies short passwords before submission');
    document.querySelector('[data-p-bulk-submit]').click(); await pause();
    const states = [...document.querySelectorAll('.p-bulk-row [role="status"]')].map(node => node.textContent);
    if (scenario === 'mixed') {
      check(states[0].includes('minimum 16') && states[1] === 'Created', 'A mixed batch shows its password error beside the successful row');
      check(!document.querySelector('[data-p-bulk-export]').disabled, 'The valid row enables credential export');
    } else if (scenario === 'rejected') {
      check(states.every(state => state.startsWith('Not created.')) && document.querySelector('[data-p-bulk-status]').textContent.includes('No mailboxes were created'), 'An explicit preflight rejection is confirmed not created');
    } else {
      check(states.every(state => state === 'Outcome unconfirmed'), 'Transport, malformed responses and server failures keep outcomes unconfirmed');
    }
    check(document.querySelector('[data-p-bulk-submit]').disabled, 'Failed requests cannot be retried without another review');
  } finally { await fixture.window.happyDOM.close(); }
}

let setupReady = false, setupFailure = false;
const setupFixture = await open('admin', '/admin/mailbox#domains', { setupResponse: async (url, domain) => {
  if (setupFailure) throw new Error('DNS unavailable');
  return { ok: true, json: async () => ({ domain, enabled: true, ready: setupReady, required: 1, complete: Number(setupReady), checked_at: 123,
    records: [{ name: '<script>untrusted</script>', type: 'MX', expected: 'mail.example.org', current: setupReady ? ['mail.example.org'] : [], required: true, status: setupReady ? 'complete' : 'missing' }] }) };
} });
try {
  const { document, requests } = setupFixture;
  check(document.querySelector('[data-p-domain-name]').textContent === 'Setup needed', 'An enabled domain with incomplete DNS is not shown as active');
  document.querySelector('.p-domain-setup-link').click(); await pause();
  const panel = document.querySelector('[data-p-domain-setup]');
  check(panel.open && panel.textContent.includes('0 / 1 required checks') && panel.textContent.includes('Missing'), 'Domain setup shows required records and completion');
  check(!panel.querySelector('script') && panel.textContent.includes('<script>untrusted</script>'), 'DNS values render as text');
  setupReady = true;
  panel.querySelector('[data-p-setup-refresh]').click(); await pause();
  check(panel.textContent.includes('Setup complete') && document.querySelector('[data-p-domain-name]').textContent === 'Active', 'A successful recheck updates the panel and domain status');
  check(requests.some(request => request.url.includes('format=json') && request.url.includes('refresh=1')), 'Recheck bypasses the DNS result cache');
  setupFailure = true;
  panel.querySelector('[data-p-setup-refresh]').click(); await pause();
  check(panel.textContent.includes('not been confirmed ready') && document.querySelector('[data-p-domain-name]').textContent === 'Check needed', 'A failed recheck cannot retain a green active status');
} finally { await setupFixture.window.happyDOM.close(); }

const login = await open('login-admin', '/admin');
try {
  const { document, errors } = login;
  check(document.getElementById('fido2-login').textContent.includes('Sign in with passkey'), 'Admin login exposes a clear passkey button');
  check(document.getElementById('fido2-login').classList.contains('btn-secondary'), 'Passkey action retains restyled mailcow buttons');
  const toggle = document.querySelector('[data-p-password]'); toggle.click();
  check(document.getElementById('pass_user').type === 'text' && toggle.getAttribute('aria-pressed') === 'true', 'Password visibility control is accessible and keyboard focusable');
  toggle.click(); check(document.getElementById('pass_user').type === 'password', 'Password can be concealed again');
  check(!document.querySelector('[data-p-preferences]') && !document.querySelector('[data-p-appearance]'), 'Login has no floating or privileged UI settings');
  check(errors.length === 0, 'Login initialization has no script errors');
} finally { await login.window.happyDOM.close(); }

const settings = await open('settings', '/admin/system#tab-ui');
try {
  const { document, window, errors } = settings;
  check(document.getElementById('tab-ui').classList.contains('active'), 'Settings deep link selects the UI tab before reveal');
  check(document.querySelector('#tab-ui [name="components"][value="redesigned"]').checked, 'UI tab shows selected component mode');
  check(document.querySelector('#tab-ui [name="ui_favicon"]') && document.querySelector('#tab-ui [name="business_name"]'), 'Branding and favicon settings are in the UI tab');
  const classic = document.querySelector('[name="ui"][value="stock"]'); classic.checked = true; classic.dispatchEvent(new window.Event('change', { bubbles: true }));
  check(document.querySelector('[data-p-component-options]').disabled, 'Component selection is disabled for the classic interface');
  check(errors.length === 0, 'UI settings have no script errors: ' + errors.join(', '));
} finally { await settings.window.happyDOM.close(); }

const dashboard = await open('dashboard', '/admin/dashboard');
try {
  const { document, requests, errors } = dashboard;
  check(requests.some(request => request.url === '/api/v1/get/overview'), 'Overview loads its dedicated read endpoint');
  check(document.querySelector('[data-p-metric="sent_messages"]').textContent === '220', 'Observed sent-message count renders');
  check(document.querySelectorAll('[data-p-activity] .p-hour').length === 25, 'Hourly activity chart renders its complete sample window');
  check(document.querySelector('[data-p-ranking="top_sending_domains"]').textContent.includes('example.org'), 'Top sending domains render safely');
  check(document.querySelector('[data-p-coverage]').textContent.includes('Retained log sample'), 'Overview exposes its retention scope');
  check(document.querySelector('[data-p-host="cpu"]').textContent === '18.2%' && document.querySelector('[data-p-host="pressure"]').textContent === '0.12%', 'Measured CPU and memory pressure render');
  check(document.querySelector('[data-p-host="storage"]').textContent === '28.0%', 'Mail filesystem usage renders independently of mailbox quotas');
  const update = document.querySelector('[data-p-server-update]');
  check(!update.disabled, 'Overview enables updates for an available host worker');
  update.click();
  check(!document.querySelector('[data-p-update-review]').hidden && !requests.some(r => r.url === '/server-update.php' && r.options.method === 'POST'), 'Update button opens a release review before queueing');
  document.querySelector('[data-p-update-confirm]').click(); await pause();
  const queued = requests.find(r => r.url === '/server-update.php' && r.options.method === 'POST');
  check(JSON.parse(queued.options.body).commit === 'a'.repeat(40) && JSON.parse(queued.options.body).csrf_token === 'update-csrf', 'Confirmation queues only the reviewed release with CSRF');
  check(update.disabled && document.querySelector('[data-p-update-status]').textContent === 'Update queued', 'Queued upgrade disables duplicate submission');
  check(errors.length === 0, 'Overview rendering has no script errors: ' + errors.join(', '));
} finally { await dashboard.window.happyDOM.close(); }

let sampleTime = Date.now() / 1000, failLive = false, holdLive = null;
const liveDashboard = await open('dashboard', '/admin/dashboard', { controlTimers: true, serverResponse: async () => {
  if (holdLive) await holdLive;
  if (failLive) throw new Error('Disconnected');
  sampleTime += 5;
  return { ok: true, json: async () => ({ generated_at: sampleTime, server: { available: true, sampled_at: sampleTime, cpu: { usage: 42, cores: 4 }, memory: { usage: 50 }, memory_pressure: { some: { avg10: .2 } }, storage: { usage_percent: 29 } }, services: [{ name: 'postfix-mailcow', running: false }] }) };
} });
try {
  const { document, window, requests, runTimer, timers } = liveDashboard;
  await runTimer(5000);
  check(document.querySelector('[data-p-host="cpu"]').textContent === '42.0%' && document.querySelector('[data-p-services]').textContent.includes('Stopped'), 'Live polling updates host measurements and service status');
  check(document.querySelector('[data-p-host-chart="cpu"] path[stroke]'), 'Graphs connect measured host samples');
  check(requests.filter(r => r.url === '/api/v1/get/overview').length === 1, 'Five-second polls do not rescan mail activity');
  let hidden = true;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new window.Event('visibilitychange'));
  check(![...timers.values()].some(timer => timer.delay === 60000 || timer.delay === 5000) && document.querySelector('[data-p-live-status]').textContent === 'Paused', 'Hidden tabs pause telemetry and mail polling');
  hidden = false; document.dispatchEvent(new window.Event('visibilitychange')); await pause();
  check(document.querySelector('[data-p-live-status]').textContent.includes('Live'), 'Visible tabs resume live telemetry');
  failLive = true; await runTimer(5000);
  check(document.querySelector('[data-p-live-status]').textContent.includes('Reconnecting') && document.querySelector('[data-p-host="cpu"]').textContent === '—', 'Disconnected stats show reconnecting and no stale current values');
  check(document.querySelector('[data-p-host-chart="cpu"] path[stroke]'), 'Reconnect preserves measured chart history');
  failLive = false; await runTimer(5000);
  check(document.querySelector('[data-p-live-status]').textContent.includes('Live'), 'Retry recovers live status');
  let release;
  holdLive = new Promise(resolve => { release = resolve; });
  const pending = runTimer(5000); await pause();
  const before = requests.filter(r => r.url.endsWith('/overview/server')).length;
  document.dispatchEvent(new window.Event('visibilitychange')); await pause();
  check(requests.filter(r => r.url.endsWith('/overview/server')).length === before, 'Slow live requests never overlap');
  release(); await pending;
  check(liveDashboard.errors.length === 0, 'Live polling has no script errors');
} finally { await liveDashboard.window.happyDOM.close(); }

const edit = await open('edit', '/edit/mailbox/alex%40example.org');
try {
  const { window, document } = edit;
  const writes = [];
  window.csrf_token = 'fixture-csrf-token'; window.lang_footer = { loading: 'Saving' };
  window.eval(await file('data/web/js/build/006-formcache.min.js'));
  window.jQuery.ajaxTransport('+*', options => ({ send(headers, complete) { writes.push(options); complete(200, 'OK', { text: '[]' }, 'Content-Type: application/json'); }, abort() {} }));
  window.eval(await file('data/web/js/build/011-api.js')); await pause();
  const form = document.querySelector('form[data-id="plates_edit_mailbox"]');
  form.querySelector('[name="name"]').value = 'Redesigned save';
  window.jQuery(form).find('[name="active"]').val('1');
  const save = form.querySelector('[data-action="edit_selected"]');
  save.setAttribute('data-api-reload-window', 'false'); save.click(); await pause();
  const write = writes.find(request => request.url === '/api/v1/edit/mailbox');
  check(write, 'Focused edit form invokes the native save handler');
  const payload = new URLSearchParams(write.data);
  const attr = JSON.parse(payload.get('attr'));
  check(payload.get('csrf_token') === 'fixture-csrf-token', 'Focused edit retains CSRF protection');
  check(attr.name === 'Redesigned save' && !('protocol_access' in attr) && !('authsource' in attr), 'Focused edit does not reset authentication or protocol settings');
  check(JSON.parse(payload.get('items'))[0] === 'alex@example.org', 'Focused edit targets the selected mailbox');
} finally { await edit.window.happyDOM.close(); }
console.log(`Plates: ${checks} redesigned-component interaction checks passed.`);
