/* Purpose-built Plates views. Existing mailcow endpoints and write handlers remain authoritative. */
(() => {
  'use strict';
  const start = () => {
    const $ = window.jQuery;
    document.querySelectorAll('[data-p-native], [data-p-domain]').forEach(select => {
      if ($?.fn.selectpicker) $(select).selectpicker('destroy');
    });
    document.addEventListener('click', event => {
      const toggle = event.target.closest('[data-p-password]');
      if (toggle) {
        const input = document.getElementById(toggle.dataset.pPassword);
        const visible = input.type === 'password';
        input.type = visible ? 'text' : 'password';
        toggle.setAttribute('aria-pressed', String(visible));
        toggle.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
        toggle.querySelector('i').className = visible ? 'bi bi-eye-slash' : 'bi bi-eye';
      }
      const close = event.target.closest('[data-p-dialog-close]');
      if (close) close.closest('dialog').close();
      const advanced = event.target.closest('[data-p-open-advanced]');
      if (advanced) document.getElementById('p-mailbox-advanced').open = true;
      const generate = event.target.closest('[data-p-generate-password]');
      if (generate) {
        const form = generate.closest('form');
        const password = randomPassword();
        for (const field of form.querySelectorAll('[name="password"], [name="password2"]')) {
          field.value = password; field.dispatchEvent(new Event('input', { bubbles: true }));
        }
        form.querySelector('[name="password"]').type = 'text';
      }
    });
    // Validate before the existing delegated API handlers receive a save/create click.
    document.addEventListener('click', event => {
      const action = event.target.closest('[data-action]');
      const form = action?.closest('form[data-p-validate]');
      if (!form) return;
      const password = form.querySelector('[name="password"]');
      const confirmation = form.querySelector('[name="password2"]');
      if (confirmation) confirmation.setCustomValidity(password.value === confirmation.value ? '' : confirmation.dataset.mismatch || 'Passwords do not match');
      if (!form.reportValidity()) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    document.addEventListener('input', event => {
      const form = event.target.closest('form[data-p-validate]');
      form?.querySelector('[name="password2"]')?.setCustomValidity('');
    });
    const root = document.querySelector('[data-p-workspace]');
    if (root) workspace(root);
    else document.documentElement.removeAttribute('data-plates-pending');
    const overviewRoot = document.querySelector('[data-p-overview]');
    if (overviewRoot) { overview(overviewRoot); updates(overviewRoot.querySelector('[data-p-updates]')); }
    document.querySelectorAll('[data-p-bulk-create]').forEach(bulkMailboxes);
  };

  function randomPassword() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function bulkMailboxes(root) {
    const source = root.querySelector('[data-p-bulk-input]');
    const domain = root.querySelector('[data-p-bulk-domain]');
    const quota = root.querySelector('[data-p-bulk-quota]');
    const results = root.querySelector('[data-p-bulk-rows]');
    const status = root.querySelector('[data-p-bulk-status]');
    const submit = root.querySelector('[data-p-bulk-submit]');
    const download = root.querySelector('[data-p-bulk-export]');
    let rows = [], sending = false;
    const credentials = new Map();
    const invalidate = () => { if (sending) return; rows = []; results.replaceChildren(); submit.disabled = true; download.disabled = credentials.size === 0; };
    for (const input of [source, domain, quota]) input.addEventListener('input', invalidate);
    root.querySelector('[data-p-bulk-preview]').addEventListener('click', () => {
      if (sending) return;
      invalidate();
      try {
        const seen = new Set();
        const lines = source.value.split(/\r?\n/).filter(line => line.trim());
        if (!lines.length || lines.length > 50 || !quota.checkValidity()) throw new Error('Enter 1–50 rows and a valid quota.');
        rows = lines.map((line, index) => {
          const parts = line.match(/(?:"(?:[^"]|"")*"|[^,]*)(?:,|$)/g).filter(Boolean).map(value => value.replace(/,$/, '').trim()).map(value => value.startsWith('"') ? value.slice(1, -1).replace(/""/g, '"') : value);
          if (parts.length > 3) throw new Error('Check CSV fields on line ' + (index + 1));
          const address = (parts[0].includes('@') ? parts[0] : parts[0] + '@' + domain.value).toLowerCase();
          const at = address.lastIndexOf('@');
          if (at < 1 || /\s/.test(address) || seen.has(address)) throw new Error('Invalid or duplicate address on line ' + (index + 1));
          if (!Array.from(domain.options).some(option => option.value === address.slice(at + 1))) throw new Error('Choose an available domain on line ' + (index + 1));
          const name = parts[1] || '';
          seen.add(address);
          return { address, local_part: address.slice(0, at), domain: address.slice(at + 1), name,
                   quota: Number(quota.value), password: parts[2] || randomPassword(), created: false };
        });
        for (const row of rows) {
          const line = document.createElement('div'); line.className = 'p-bulk-row';
          const identity = document.createElement('span'); identity.textContent = row.address;
          const password = document.createElement('input'); password.type = 'password'; password.value = row.password; password.autocomplete = 'new-password'; password.setAttribute('aria-label', 'Password for ' + row.address);
          password.addEventListener('input', () => { row.password = password.value; });
          const state = document.createElement('span'); state.textContent = 'Ready'; state.setAttribute('role', 'status');
          row.node = line; row.state = state; row.passwordInput = password;
          line.append(identity, password, state); results.append(line);
        }
        submit.disabled = false; status.textContent = rows.length + ' mailboxes ready for review. Passwords remain in this browser until you close the dialog.';
      } catch (error) { invalidate(); status.textContent = error.message; }
    });
    submit.addEventListener('click', async () => {
      if (sending || !rows.length) return;
      sending = true; submit.disabled = true;
      for (const input of root.querySelectorAll('input, textarea, select, button')) input.disabled = true;
      try {
        const pending = rows.filter(row => !row.created);
        const response = await fetch('/mailbox-batch.php', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csrf_token: window.csrf_token, rows: pending.map(({ local_part, domain, name, quota, password }) => ({ local_part, domain, name, quota, password })) }) });
        const data = await response.json();
        if (data.csrf_token) window.csrf_token = data.csrf_token;
        if (!response.ok || !Array.isArray(data.results)) throw new Error(data.message || 'Batch failed; check mailbox inventory before retrying.');
        for (const row of pending) {
          const result = data.results.find(result => result.address === row.address);
          row.created = result?.created === true;
          if (row.created) credentials.set(row.address, { address: row.address, name: row.name, password: row.password });
          row.state.textContent = result?.message || 'Not processed';
        }
        status.textContent = rows.filter(row => row.created).length + ' / ' + rows.length + ' mailboxes created. Download the created credentials before leaving.';
        // Reuse the existing list refresh without reloading or losing generated credentials.
        document.querySelector('[data-p-refresh]')?.click();
      } catch (error) {
        status.textContent = error.message + ' Check inventory before submitting another batch.';
        rows.forEach(row => { if (!row.created) row.state.textContent = 'Outcome unconfirmed'; });
      } finally {
        sending = false;
        for (const input of root.querySelectorAll('input, textarea, select, button')) input.disabled = false;
        rows.forEach(row => { row.passwordInput.disabled = row.created; });
        // Require another explicit review for failures; never automatically retry a possibly committed write.
        submit.disabled = true; download.disabled = credentials.size === 0;
      }
    });
    download.addEventListener('click', () => {
      const escape = value => { const text = String(value); return '"' + (/^[=+@\-\t\r]/.test(text) ? "'" : '') + text.replace(/"/g, '""') + '"'; };
      const csv = ['address,name,password', ...Array.from(credentials.values()).map(row => [row.address, row.name, row.password].map(escape).join(','))].join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = 'mailbox-credentials.csv'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    root.closest('dialog').addEventListener('close', () => {
      if (!sending) { source.value = ''; credentials.clear(); invalidate(); status.textContent = ''; }
    });
  }

  function workspace(root) {
    const copy = JSON.parse(document.getElementById('p-workspace-copy').textContent);
    const results = root.querySelector('[data-p-results]');
    const search = root.querySelector('[data-p-search]');
    const domain = root.querySelector('[data-p-domain]');
    const domainKey = 'plates:domain:' + location.pathname + ':' + (root.dataset.pUser || '');
    const saveDomain = () => { try { localStorage.setItem(domainKey, domain.value); } catch (_) {} };
    try {
      const saved = localStorage.getItem(domainKey);
      if (saved && Array.from(domain.options).some(option => option.value === saved)) domain.value = saved;
    } catch (_) {}
    const create = root.querySelector('[data-p-create]');
    let task = 'tab-domains', page = 0, total = 0, request = null, sequence = 0, timer;
    const limit = 20;
    const tasks = {
      'tab-domains': { title: copy.domains, hint: copy.domain_hint, add: copy.add_domain, kind: 'domain', icon: 'globe2' },
      'tab-mailboxes': { title: copy.mailboxes, hint: copy.mailbox_hint, add: copy.add_mailbox, kind: 'mailbox', icon: 'envelope' },
      'tab-mbox-aliases': { title: copy.aliases, hint: copy.alias_hint, add: copy.add_alias, kind: 'alias', icon: 'signpost-split' },
    };
    const fragments = { 'tab-domains': 'domains', 'tab-mailboxes': 'mailboxes', 'tab-mbox-aliases': 'aliases' };
    const taskFromFragment = value => Object.keys(fragments).find(key => fragments[key] === value) || value;
    const element = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = String(text);
      return node;
    };
    const icon = name => { const node = element('i', 'bi bi-' + name); node.setAttribute('aria-hidden', 'true'); return node; };
    const bytes = value => {
      const number = Number(value);
      if (!Number.isFinite(number)) return String(value ?? '—');
      if (number >= 1073741824) return (number / 1073741824).toFixed(1) + ' GiB';
      return Math.round(number / 1048576) + ' MiB';
    };
    const textState = (title, hint, type) => {
      const state = element('div', 'p-empty');
      state.append(icon(type || 'inbox'), element('h2', '', title), element('p', '', hint || ''));
      results.replaceChildren(state);
    };
    function row(item) {
      const kind = tasks[task].kind;
      const node = element('article', 'p-data-row');
      const identity = element('div', 'p-row-identity');
      identity.append(element('span', 'p-row-icon'));
      identity.firstChild.append(icon(tasks[task].icon));
      const text = element('div');
      const label = kind === 'domain' ? item.domain_h_name || item.domain_name : kind === 'mailbox' ? item.username : item.address;
      const sub = kind === 'domain' ? item.description : kind === 'mailbox' ? item.name : item.goto;
      const target = kind === 'alias' && item.group_id ? '/edit/mailbox-group/' + encodeURIComponent(item.group_id) : '/edit/' + kind + '/' + encodeURIComponent(kind === 'domain' ? item.domain_name : kind === 'mailbox' ? item.username : item.id);
      const link = element('a', 'p-row-title', label);
      link.href = target;
      text.append(link, element('span', 'p-row-subtitle', sub || '—'));
      identity.append(text);
      const status = element('span', Number(item.active) === 1 ? 'p-status p-status-active' : 'p-status p-status-inactive', Number(item.active) === 1 ? copy.active : copy.inactive);
      const detail = element('div', 'p-row-detail');
      if (kind === 'mailbox') {
        detail.append(element('span', '', bytes(item.quota_used) + ' / ' + (Number(item.quota) === 0 ? '∞' : bytes(item.quota))), element('div', 'p-storage-meter'));
        const used = Math.min(100, Math.max(0, Number(item.percent_in_use) || 0));
        const fill = element('span'); fill.style.width = used + '%';
        detail.lastChild.append(fill);
        detail.setAttribute('aria-label', copy.storage + ': ' + used + '%');
      } else if (kind === 'domain') {
        const count = element('button', 'p-domain-count', (item.mboxes_in_domain ?? 0) + ' ' + copy.mailboxes);
        count.type = 'button'; count.title = copy.open_mailboxes;
        count.addEventListener('click', () => { domain.value = item.domain_name; saveDomain(); search.value = ''; select('tab-mailboxes', true); });
        detail.append(count, element('span', 'p-row-subtitle', item.quota_used_in_domain || '—'));
      } else detail.append(element('span', 'p-row-subtitle', item.public_comment || ''));
      const edit = element('a', 'p-row-open'); edit.href = target; edit.setAttribute('aria-label', copy.edit + ' ' + label); edit.append(icon('arrow-up-right'));
      node.append(identity, detail, status, edit);
      return node;
    }
    function footer() {
      root.querySelector('[data-p-result-count]').textContent = (total ? `${page * limit + 1}–${Math.min(total, (page + 1) * limit)} / ${total}` : '0') + ' ' + copy.results;
      root.querySelector('[data-p-previous]').disabled = page === 0;
      root.querySelector('[data-p-next]').disabled = (page + 1) * limit >= total;
    }
    async function load() {
      request?.abort(); request = new AbortController();
      const current = ++sequence;
      results.setAttribute('aria-busy', 'true');
      textState(copy.loading, '', 'hourglass-split');
      root.querySelector('[data-p-previous]').disabled = root.querySelector('[data-p-next]').disabled = true;
      try {
        const kind = tasks[task].kind;
        const options = { credentials: 'same-origin', signal: request.signal };
        let url = '/api/v1/get/alias/all';
        if (kind !== 'alias') {
          const columns = Array.from({ length: 25 }, (_, index) => ({ data: index, searchable: index === 2 || (kind === 'mailbox' && index === 7) ? 'true' : 'false', orderable: 'true', search: { value: '', regex: false } }));
          const payload = { draw: current, start: page * limit, length: limit, search: { value: search.value, regex: false }, order: [{ column: 2, dir: 'asc' }], columns };
          if (kind === 'mailbox' && domain.value) payload.domain = domain.value;
          Object.assign(options, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          url = '/api/v1/search/' + kind;
        }
        const response = await fetch(url, options);
        if (!response.ok) throw new Error('Request failed');
        const data = await response.json();
        if (current !== sequence) return;
        let rows;
        if (kind === 'alias') {
          // mailcow's GET lists return {} when no rows exist.
          const aliases = Array.isArray(data) ? data : data && typeof data === 'object' && Object.keys(data).length === 0 ? [] : null;
          if (!aliases) throw new Error('Invalid response');
          const filtered = aliases.filter(item => [item.address, item.goto, item.public_comment].some(value => String(value || '').toLocaleLowerCase().includes(search.value.toLocaleLowerCase())));
          total = filtered.length; rows = filtered.slice(page * limit, (page + 1) * limit);
        } else {
          if (!Array.isArray(data.data) || !Number.isFinite(Number(data.recordsFiltered))) throw new Error('Invalid response');
          total = Number(data.recordsFiltered); rows = data.data;
        }
        const filtered = search.value || (kind === 'mailbox' && domain.value);
        if (!rows.length) textState(filtered ? copy.no_results : copy.empty_title, filtered ? copy.no_results_hint : copy.empty_hint);
        else results.replaceChildren(...rows.map(row));
        footer();
      } catch (error) {
        if (error.name !== 'AbortError' && current === sequence) { total = 0; textState(copy.load_error, '', 'exclamation-circle'); footer(); }
      } finally { if (current === sequence) results.setAttribute('aria-busy', 'false'); }
    }
    function select(id, push = false) {
      if (!tasks[id]) {
        const legacy = document.querySelector('#mail-content button[data-bs-target="#' + CSS.escape(id) + '"]');
        select('tab-domains');
        if (legacy) {
          const advanced = document.querySelector('[data-p-advanced]'); advanced.open = true;
          window.bootstrap.Tab.getOrCreateInstance(legacy).show();
          advanced.scrollIntoView({ block: 'start' });
          const url = new URL(location.href); url.hash = id; history.replaceState(null, '', url);
        }
        return;
      }
      task = id; page = 0;
      document.querySelector('[data-p-advanced]').open = false;
      root.querySelector('[data-p-title]').textContent = tasks[id].title;
      root.querySelector('[data-p-hint]').textContent = tasks[id].hint;
      create.querySelector('span').textContent = tasks[id].add;
      create.hidden = id === 'tab-domains' && root.dataset.pRole !== 'admin';
      root.querySelector('[data-p-domain-wrap]').hidden = id !== 'tab-mailboxes';
      document.querySelectorAll('[data-p-task], .plates-rail [data-plates-tab]').forEach(button => {
        const selected = (button.dataset.pTask || button.dataset.platesTab) === id;
        button.classList.toggle('p-selected', selected);
        if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
      });
      const url = new URL(location.href); url.hash = fragments[id];
      if (url.href !== location.href) history[push ? 'pushState' : 'replaceState'](null, '', url);
      try { sessionStorage.setItem('plates-task:' + location.pathname, id); } catch (_) {}
      document.documentElement.removeAttribute('data-plates-pending');
      load();
    }
    document.addEventListener('click', event => {
      const button = event.target.closest('[data-p-task], .plates-rail [data-plates-tab]');
      if (!button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      if (button.href && new URL(button.href).pathname !== location.pathname) return;
      event.preventDefault();
      search.value = '';
      select(button.dataset.pTask || button.dataset.platesTab, true);
      const rail = document.getElementById('plates-navigation');
      if (rail?.classList.contains('show')) window.bootstrap.Offcanvas.getInstance(rail)?.hide();
    });
    const restore = () => { search.value = ''; select(taskFromFragment(location.hash.slice(1)) || 'tab-domains'); };
    window.addEventListener('popstate', restore);
    window.addEventListener('hashchange', restore);
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { page = 0; load(); }, 250); });
    domain.addEventListener('change', () => { saveDomain(); page = 0; load(); });
    root.querySelector('[data-p-refresh]').addEventListener('click', load);
    root.querySelector('[data-p-previous]').addEventListener('click', () => { page--; load(); });
    root.querySelector('[data-p-next]').addEventListener('click', () => { page++; load(); });
    create.addEventListener('click', () => {
      const dialog = document.getElementById('p-create-' + tasks[task].kind);
      if (dialog) {
        dialog.querySelector('form').reset();
        if (domain.value) dialog.querySelectorAll('[name="domain"], [data-p-bulk-domain]').forEach(select => {
          if (Array.from(select.options).some(option => option.value === domain.value)) select.value = domain.value;
        });
        dialog.showModal();
      }
    });
    let remembered; try { remembered = sessionStorage.getItem('plates-task:' + location.pathname); } catch (_) {}
    select(taskFromFragment(location.hash.slice(1)) || remembered || 'tab-domains');
    // Browsers can reveal a details ancestor while resolving an old #tab-* URL.
    // The selected core view owns those fragments in the redesigned interface.
    window.addEventListener('load', () => {
      if (tasks[taskFromFragment(location.hash.slice(1))]) document.querySelector('[data-p-advanced]').open = false;
    }, { once: true });
  }
  function overview(root) {
    const copy = JSON.parse(document.getElementById('p-overview-copy').textContent);
    const button = root.querySelector('[data-p-overview-refresh]');
    const format = new Intl.NumberFormat();
    const date = time => new Date(time * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const text = (tag, className, value) => { const el = document.createElement(tag); if (className) el.className = className; el.textContent = value; return el; };
    const load = async () => {
      button.disabled = true; root.setAttribute('aria-busy', 'true');
      const started = performance.now();
      try {
        const response = await fetch('/api/v1/get/overview', { credentials: 'same-origin' });
        if (!response.ok) throw new Error('Unavailable');
        const data = await response.json();
        if (!data.counts || !data.inventory || !Array.isArray(data.hourly) || !data.coverage) throw new Error('Invalid metrics');
        const gib = value => Number.isFinite(Number(value)) ? (Number(value) / 1073741824).toFixed(1) + ' GiB' : '—';
        const host = data.server || {};
        const hostValues = {
          cpu: host.cpu ? Number(host.cpu.usage).toFixed(1) + '%' : '—',
          cores: host.cpu ? host.cpu.cores + ' logical cores' : 'Host telemetry unavailable',
          memory: host.memory ? Number(host.memory.usage).toFixed(1) + '%' : '—',
          memory_available: host.memory ? gib(host.memory.available) + ' available / ' + gib(host.memory.total) : 'Unavailable',
          pressure: host.memory_pressure?.some ? Number(host.memory_pressure.some.avg10).toFixed(2) + '%' : 'Unavailable',
          storage: host.storage ? Number(host.storage.usage_percent).toFixed(1) + '%' : '—',
          storage_available: host.storage ? gib(host.storage.available_bytes) + ' available / ' + gib(host.storage.total_bytes) : 'Unavailable',
          uptime: Number.isFinite(Number(host.uptime)) ? Math.floor(host.uptime / 86400) + 'd ' + Math.floor(host.uptime % 86400 / 3600) + 'h' : '—',
        };
        root.querySelectorAll('[data-p-host]').forEach(el => { el.textContent = hostValues[el.dataset.pHost] ?? '—'; });
        root.querySelectorAll('[data-p-timing]').forEach(el => {
          const value = data.timings?.[el.dataset.pTiming];
          el.textContent = typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) + ' s' : 'No samples';
        });
        root.querySelectorAll('[data-p-timing-samples]').forEach(el => { el.textContent = format.format(data.timings?.[el.dataset.pTimingSamples] ?? 0) + ' measured recipient deliveries'; });
        root.querySelector('[data-p-api-time]').textContent = Math.round(performance.now() - started) + ' ms';
        root.querySelectorAll('[data-p-metric]').forEach(el => { el.textContent = format.format(data.counts[el.dataset.pMetric] ?? 0); });
        root.querySelectorAll('[data-p-inventory]').forEach(el => {
          const value = data.inventory[el.dataset.pInventory] ?? 0;
          el.textContent = el.dataset.pInventory === 'used_bytes' ? (value / 1073741824).toFixed(1) + ' GiB' : format.format(value);
        });
        const coverage = data.coverage;
        root.querySelector('[data-p-coverage]').textContent = coverage.newest_retained && coverage.newest_retained >= coverage.requested_since ? `${copy.coverage} · ${date(Math.max(coverage.oldest_retained, coverage.requested_since))} – ${date(coverage.newest_retained)} · ${format.format(coverage.scanned_lines)} entries${coverage.capped ? ' (capped)' : ''}` : copy.empty;
        const chart = root.querySelector('[data-p-activity]');
        const max = Math.max(1, ...data.hourly.flatMap(hour => [hour.sent, hour.received]));
        chart.replaceChildren(...data.hourly.map(hour => {
          const column = text('div', 'p-hour', '');
          column.title = `${date(hour.time)} · ${copy.sent}: ${hour.sent} · ${copy.received}: ${hour.received}`;
          for (const key of ['sent', 'received']) { const bar = text('span', 'p-hour-' + key, ''); bar.style.height = (140 * hour[key] / max) + 'px'; column.append(bar); }
          column.setAttribute('aria-hidden', 'true');
          return column;
        }));
        chart.setAttribute('aria-label', `${copy.sent}: ${data.counts.outbound_deliveries}; ${copy.received}: ${data.counts.inbound_deliveries}`);
        root.querySelector('[data-p-activity-times]').replaceChildren(...data.hourly.filter((hour, index) => index % 6 === 0).map(hour => text('span', '', new Date(hour.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))));
        root.querySelectorAll('[data-p-ranking]').forEach(list => {
          const rows = data[list.dataset.pRanking] || [];
          const max = Math.max(1, ...rows.map(row => row.deliveries));
          list.replaceChildren(...(rows.length ? rows.map(row => {
            const item = text('li', '', '');
            const label = text('div', '', ''); label.append(text('span', '', row.domain), text('strong', '', format.format(row.deliveries)));
            const track = text('div', 'p-ranking-track', ''); const fill = text('span', '', ''); fill.style.width = (100 * row.deliveries / max) + '%'; track.append(fill);
            item.append(label, track); return item;
          }) : [text('li', 'p-ranking-empty', copy.empty)]));
        });
      } catch (_) {
        root.querySelector('[data-p-coverage]').textContent = copy.error;
        root.querySelectorAll('[data-p-host], [data-p-timing], [data-p-api-time]').forEach(el => { el.textContent = '—'; });
        root.querySelectorAll('[data-p-metric], [data-p-inventory]').forEach(el => { el.textContent = '—'; });
        root.querySelector('[data-p-activity]').replaceChildren();
        root.querySelector('[data-p-activity-times]').replaceChildren();
        root.querySelectorAll('[data-p-ranking]').forEach(list => list.replaceChildren(text('li', 'p-ranking-empty', copy.error)));
      } finally { button.disabled = false; root.setAttribute('aria-busy', 'false'); }
    };
    button.addEventListener('click', load);
    load();
  }

  function updates(root) {
    if (!root) return;
    const button = root.querySelector('[data-p-server-update]');
    const confirm = root.querySelector('[data-p-update-confirm]');
    const status = root.querySelector('[data-p-update-status]');
    const review = root.querySelector('[data-p-update-review]');
    let candidate = null, polling = null;
    const load = async () => {
      try {
        const response = await fetch('/server-update.php', { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw new Error('Update service unavailable');
        const data = await response.json();
        candidate = data.candidate;
        button.disabled = !data.ready || !candidate || data.busy;
        status.textContent = data.message || 'Update service unavailable';
        if (data.csrf_token) window.csrf_token = data.csrf_token;
        if (data.busy && !polling) polling = setTimeout(() => { polling = null; load(); }, 5000);
      } catch (_) {
        button.disabled = true;
        status.textContent = 'Update service is unavailable or the server is restarting. Retrying…';
        if (!polling) polling = setTimeout(() => { polling = null; load(); }, 10000);
      }
    };
    button.addEventListener('click', () => {
      if (!candidate) return;
      root.querySelector('[data-p-update-release]').textContent = 'Install ' + candidate.slice(0, 12) + ' from the configured Mailcow Simplified repository.';
      review.hidden = false; review.open = true;
    });
    confirm.addEventListener('click', async () => {
      confirm.disabled = true; button.disabled = true;
      try {
        const response = await fetch('/server-update.php', { method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commit: candidate, csrf_token: window.csrf_token }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Update was not queued');
        review.hidden = true; status.textContent = data.message; await load();
      } catch (error) { status.textContent = error.message; }
      finally { confirm.disabled = false; }
    });
    load();
  }
  if (window.jQuery) window.jQuery(() => setTimeout(start, 0));
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
