/** Run the native mailbox initializer with real Bootstrap, DataTables and API handlers. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
const { Window } = await import(process.env.HAPPY_DOM_MODULE ? pathToFileURL(process.env.HAPPY_DOM_MODULE).href : 'happy-dom');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.env.PLATES_PREVIEW_DIR || join(tmpdir(), 'mailcow-plates-preview');
const read = name => readFile(join(root, name), 'utf8');
const pause = () => new Promise(resolve => setTimeout(resolve, 80));
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };

for (const [name, initiallyEmpty] of [['stock', false], ['admin-original', false], ['admin', false], ['admin-original', true]]) {
  const window = new Window({ url: 'http://localhost/admin/mailbox', settings: { enableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  try {
    const html = await readFile(join(output, name + '.html'), 'utf8');
    window.document.write(html.replace(/<script\b(?![^>]*type="application\/json")[^>]*>[\s\S]*?<\/script>/gi, ''));
    window.document.close();
    window.Option = function (text, value, defaultSelected, selected) {
      const option = window.document.createElement('option');
      option.text = text; option.value = value; option.defaultSelected = !!defaultSelected; option.selected = !!selected;
      return option;
    };
    const observed = new Map(), errors = [], requests = [];
    let emptyAliases = initiallyEmpty;
    window.addEventListener('error', event => errors.push(event.message));
    // A DOM has no viewport; explicitly signal visibility when a native panel opens.
    window.IntersectionObserver = class {
      constructor(callback) { this.callback = callback; }
      observe(element) { observed.set(element.id, () => this.callback([{ intersectionRatio: 1 }], this)); }
      unobserve() {}
    };
    for (const script of ['000-jquery-3.6.0.min.js', '001-bootstrap.bundle.min.js', '004-datatables.js', '006-formcache.min.js', '011-api.js']) window.eval(await read('data/web/js/build/' + script));
    // Bootstrap Select needs browser layout. Keep only that visual enhancement inert.
    window.jQuery.fn.selectpicker = function () { return this; };
    window.jQuery.fn.tooltip = function () { return this; };
    window.escapeHtml = value => window.jQuery('<span>').text(String(value)).html();
    for (const [, script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) if (script.includes('var acl =')) window.eval(script);
    window.lang_footer = { loading: 'Saving' };
    window.jQuery.ajaxTransport('+*', options => ({
      send(headers, complete) {
        requests.push(options);
        const data = options.url.includes('/search/') ? { draw: JSON.parse(options.data).draw, recordsTotal: 0, recordsFiltered: 0, data: [] }
          : options.url.includes('/get/domain/') ? { def_new_mailbox_quota: 1073741824, max_new_mailbox_quota: 10737418240 }
          : options.url.includes('/get/alias/') ? (emptyAliases ? {} : [{ id: 5, address: 'team@example.org', goto: 'alex@example.org', domain: 'example.org', active: 1, is_catch_all: 0, in_primary_domain: '', public_comment: '', private_comment: '', sogo_visible: 1, internal: 0, sender_allowed: 1 }]) : [];
        // Native initComplete expects the asynchronous timing of a network request.
        setTimeout(() => complete(200, 'OK', { text: JSON.stringify(data) }, 'Content-Type: application/json'), 0);
      }, abort() {},
    }));
    window.eval(await read('data/web/js/site/mailbox.js'));
    window.eval(await read('data/web/ui/plates/assets/plates.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await pause(); await pause();
    check(observed.has('mailbox_table') && observed.has('alias_table'), name + ': native initializer reaches lazy table setup');
    for (const [id, url] of [['mailbox_table', '/api/v1/search/mailbox'], ['alias_table', '/api/v1/get/alias/all']]) {
      const panel = window.document.getElementById(id).closest('[role="tabpanel"]');
      const button = window.document.querySelector('[data-bs-target="#' + panel.id + '"]');
      window.bootstrap.Tab.getOrCreateInstance(button).show();
      observed.get(id)(); await pause();
      check(requests.some(request => request.url.split('?')[0] === url), name + ': native ' + id + ' loads through its real endpoint');
      check(window.jQuery.fn.DataTable.isDataTable('#' + id), name + ': native ' + id + ' initializes');
    }
    check(initiallyEmpty ? window.jQuery('#alias_table').DataTable().rows().count() === 0 : window.document.querySelector('#alias_table tbody').textContent.includes('team@example.org'), name + ': native aliases render on first load');
    emptyAliases = true;
    window.jQuery('#alias_table').DataTable().ajax.reload(); await pause();
    check(window.jQuery('#alias_table').DataTable().rows().count() === 0, name + ': native alias table accepts empty-object response');
    const form = window.document.querySelector('form[data-id="add_alias"]');
    form.querySelector('[name="address"]').value = 'native@example.org';
    form.querySelector('[name="goto"]').value = 'alex@example.org';
    const create = form.querySelector('[data-action="add_item"]');
    create.setAttribute('data-api-reload-window', 'false'); create.click(); await pause();
    const write = requests.find(request => request.url === '/api/v1/add/alias');
    check(write && JSON.parse(new URLSearchParams(write.data).get('attr')).address === 'native@example.org', name + ': native alias form invokes its API handler');
    check(!errors.length, name + ': native initialization has no errors: ' + errors.join(', '));
  } finally { await window.happyDOM.close(); }
}
console.log(`Plates: ${checks} native mailbox integration checks passed.`);
