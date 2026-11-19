/** Local-only fixture preview: serves real templates/scripts, never a real mail API. */
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const web = join(root, 'data/web');
const output = process.env.PLATES_PREVIEW_DIR || join(tmpdir(), 'mailcow-plates-preview');
const types = { '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.html': 'text/html' };
const domains = ['example.org', 'studio.co.za'].map((domain_name, i) => ({
  domain_name, domain_h_name: domain_name, description: i ? 'Studio mail' : 'Team mail',
  aliases_in_domain: i ? 2 : 6, max_num_aliases_for_domain: 100,
  mboxes_in_domain: i ? 1 : 2, max_num_mboxes_for_domain: 50,
  quota_used_in_domain: '1.2 GiB', max_quota_for_domain: '100 GiB', bytes_total: '1.2 GiB',
  msgs_total: 1874, def_quota_for_mbox: 5368709120, max_quota_for_mbox: 10737418240,
  def_new_mailbox_quota: 5368709120, max_new_mailbox_quota: 10737418240,
  active: 1, backupmx: 0, relay_all_recipients: 0, relay_unknown_only: 0, tags: [],
}));
const mailboxes = [
  ['alex@example.org', 'Alex Morgan', 1, 24],
  ['hello@example.org', 'Customer support', 1, 8],
  ['ops@studio.co.za', 'Studio operations', 0, 42],
].map(([username, name, active, used]) => ({
  username, name, active, domain: username.split('@')[1],
  quota: 5368709120, quota_used: Math.round(5368709120 * used / 100), max_quota_for_mbox: 10737418240,
  percent_in_use: used, percent_class: 'success', messages: 1874,
  last_imap_login: 1794915000, last_smtp_login: 1794915000, last_sso_login: 1794915000,
  last_pop3_login: 0, last_pw_change: '12 Nov 2026', tags: [],
  created: '2026-11-01 12:00:00', modified: '2026-11-12 12:00:00', authsource: 'mailcow',
  attributes: { passwd_update: '2026-11-12 12:00:00', imap_access: 1, pop3_access: 0, smtp_access: 1, sieve_access: 1, sogo_access: 1, eas_access: 1, dav_access: 1, shared: 0, quarantine_notification: 'daily', quarantine_category: 'reject' },
}));

async function bundle(files, separator = '\n;\n') {
  return (await Promise.all(files.map(path => readFile(join(web, path), 'utf8')))).join(separator);
}

export async function buildPreviewAssets() {
  const build = (await readdir(join(web, 'js/build'))).filter(name => name.endsWith('.js')).sort().map(name => 'js/build/' + name);
  const baseJS = await bundle(build);
  const mailJS = baseJS + '\n;\n' + await bundle(['js/site/imapsync.js', 'js/site/groups.js', 'js/site/mailbox.js', 'js/presets/sieveMailbox.js', 'js/site/pwgen.js']);
  const editJS = baseJS + '\n;\n' + await bundle(['js/site/imapsync.js', 'js/site/groups.js', 'js/site/edit.js', 'js/site/pwgen.js']);
  const styles = (await readdir(join(web, 'css/build'))).filter(name => name.endsWith('.css')).sort().map(name => 'css/build/' + name);
  // A JS statement separator is invalid between CSS files: it swallows the next
  // file's first rule, including Bootstrap Icons' @font-face declaration.
  const css = await bundle(['css/themes/lumen-bootstrap.css', ...styles, 'css/site/mailbox.css', 'css/site/edit.css'], '\n');
  return { baseJS, mailJS, editJS, css };
}

export async function startPreview(port = 0) {
  const writes = [];
  const { baseJS, mailJS, editJS, css } = await buildPreviewAssets();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (data, type = 'application/json', status = 200) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(typeof data === 'object' && !Buffer.isBuffer(data) ? JSON.stringify(data) : data);
    };
    try {
      if (url.pathname === '/server-update.php') return send({ ready: false, busy: false, candidate: null, message: 'Local preview: host upgrades are disabled.' });
      if (url.pathname === '/mailbox-batch.php') return send({ message: 'Local preview: mailbox creation is disabled.' }, 'application/json', 403);
      if (url.pathname.startsWith('/api/v1/') || url.pathname.startsWith('/inc/ajax/')) {
        let raw = '';
        for await (const part of req) raw += part;
        let payload = {};
        try { payload = JSON.parse(raw); } catch { payload = Object.fromEntries(new URLSearchParams(raw)); }
        if (/\/api\/v1\/(add|edit|delete)\//.test(url.pathname)) {
          writes.push({ path: url.pathname, payload });
          return send([{ type: 'success', msg: 'Fixture only: request captured' }]);
        }
        if (url.pathname === '/api/v1/get/overview') return send(await readFile(join(output, 'overview.json')), 'application/json');
        if (url.pathname === '/api/v1/search/domain' || url.pathname === '/api/v1/search/mailbox') {
          const source = url.pathname.endsWith('/domain') ? domains : mailboxes;
          const scoped = payload.domain ? source.filter(item => item.domain === payload.domain) : source;
          const search = String(payload.search?.value || '').toLowerCase();
          const rows = scoped.filter(item => !search || JSON.stringify(item).toLowerCase().includes(search));
          const start = Number(payload.start) || 0;
          return send({ draw: Number(payload.draw) || 1, recordsTotal: scoped.length, recordsFiltered: rows.length, data: rows.slice(start, start + (Number(payload.length) || 25)) });
        }
        if (url.pathname === '/api/v1/get/alias/all') return send([{ id: 1, address: 'team@example.org', goto: 'alex@example.org,hello@example.org', active: 1, public_comment: 'Team' }]);
        if (url.pathname === '/api/v1/get/passwordpolicy/html') return send('', 'text/html');
        if (url.pathname.startsWith('/api/v1/get/domain/template/')) return send([]);
        if (url.pathname.startsWith('/api/v1/get/domain/')) return send(domains.find(item => item.domain_name === decodeURIComponent(url.pathname.split('/').at(-1))) || domains[0]);
        if (url.pathname.includes('/passwordpolicy')) return send({ min_length: 8, max_length: 128, lower: 1, upper: 1, chars: 1, numbers: 1 });
        return send([]);
      }
      if (url.pathname === '/fixtures/mailcow.js') return send(mailJS, types['.js']);
      if (url.pathname === '/fixtures/edit.js') return send(editJS, types['.js']);
      if (url.pathname === '/fixtures/base.js') return send(baseJS, types['.js']);
      if (url.pathname === '/fixtures/mailcow.css') return send(css, types['.css']);
      const cookie = req.headers.cookie || '';
      const preference = url.searchParams.get('ui');
      const components = url.searchParams.get('components');
      const cookies = [];
      if (['stock', 'plates'].includes(preference)) cookies.push(`mailcow_presentation=${preference}; Path=/; SameSite=Lax; HttpOnly`);
      if (['original', 'redesigned'].includes(components)) cookies.push(`mailcow_components=${components}; Path=/; SameSite=Lax; HttpOnly`);
      if (cookies.length) res.setHeader('Set-Cookie', cookies);
      const stock = preference === 'stock' || (!preference && cookie.includes('mailcow_presentation=stock'));
      const original = components === 'original' || (!components && cookie.includes('mailcow_components=original'));
      const pages = { '/admin/mailbox': stock ? 'stock' : original ? 'admin-original' : 'admin', '/domainadmin/mailbox': original ? 'domainadmin-original' : 'domainadmin', '/user': 'user', '/': stock ? 'login-stock' : original ? 'login-original' : 'login', '/admin': stock ? 'login-admin-stock' : original ? 'login-admin-original' : 'login-admin', '/domainadmin': stock ? 'login-domainadmin-stock' : original ? 'login-domainadmin-original' : 'login-domainadmin', '/admin/dashboard': original || stock ? 'dashboard-original' : 'dashboard', '/admin/system': stock ? 'settings-stock' : original ? 'settings-original' : 'settings', '/quarantine': 'quarantine', '/admin/queue': 'queue' };
      const page = url.pathname.startsWith('/edit/mailbox/') ? (original ? 'edit-original' : 'edit') : pages[url.pathname];
      if (page) return send(await readFile(join(output, page + '.html')), types['.html']);
      // Only static public assets are exposed. Never serve PHP, Twig, or configuration.
      const path = resolve(web, '.' + decodeURIComponent(url.pathname));
      if (!path.startsWith(web + sep) || !types[extname(path)] || ['.json', '.html'].includes(extname(path))) return send('Not found', 'text/plain', 404);
      return send(await readFile(path), types[extname(path)]);
    } catch (error) {
      send('Fixture not found: ' + url.pathname, 'text/plain', 404);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, writes, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const preview = await startPreview(Number(process.env.PORT) || 8765);
  console.log(`Plates fixture preview: ${preview.url}/admin/mailbox (local demo data only)`);
}
