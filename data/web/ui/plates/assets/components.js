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
      else if (action.dataset.apiUrl === 'add/domain') {
        try { sessionStorage.setItem('plates:setup-domain', form.querySelector('[name="domain"]').value.trim().toLowerCase()); } catch (_) {}
      }
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
    // Retain 128 random bits and include every character class required by native policies.
    return 'aA1!' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
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
    const passwordError = password => {
      const length = new Blob([password]).size;
      return length < 16 ? 'Password is too short (minimum 16).' : length > 256 ? 'Password is too long (maximum 256).' : '';
    };
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
          const previous = credentials.get(address);
          return { address, local_part: address.slice(0, at), domain: address.slice(at + 1), name,
                   quota: Number(quota.value), password: previous?.password || parts[2] || randomPassword(), created: !!previous };
        });
        for (const row of rows) {
          const line = document.createElement('div'); line.className = 'p-bulk-row';
          const identity = document.createElement('span'); identity.textContent = row.address;
          const password = document.createElement('input'); password.type = 'password'; password.value = row.password; password.autocomplete = 'new-password'; password.setAttribute('aria-label', 'Password for ' + row.address);
          password.disabled = row.created;
          const state = document.createElement('span'); state.textContent = row.created ? 'Already created' : passwordError(row.password) || 'Ready'; state.setAttribute('role', 'status');
          state.className = row.created ? 'p-bulk-success' : passwordError(row.password) ? 'p-bulk-error' : '';
          password.setAttribute('aria-invalid', String(!!passwordError(row.password)));
          password.addEventListener('input', () => {
            row.password = password.value;
            const error = passwordError(row.password);
            state.textContent = error || 'Ready'; state.className = error ? 'p-bulk-error' : '';
            password.setAttribute('aria-invalid', String(!!error));
          });
          row.node = line; row.state = state; row.passwordInput = password;
          line.append(identity, password, state); results.append(line);
        }
        submit.disabled = rows.every(row => row.created); status.textContent = rows.length + ' mailboxes reviewed. Valid rows will be created; invalid rows will show errors. Passwords remain in this browser until you close the dialog.';
      } catch (error) { invalidate(); status.textContent = error.message; }
    });
    submit.addEventListener('click', async () => {
      if (sending || !rows.length) return;
      sending = true; submit.disabled = true;
      let rejected = false;
      for (const input of root.querySelectorAll('input, textarea, select, button')) input.disabled = true;
      try {
        const pending = rows.filter(row => !row.created);
        const response = await fetch('/mailbox-batch.php', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csrf_token: window.csrf_token, rows: pending.map(({ local_part, domain, name, quota, password }) => ({ local_part, domain, name, quota, password })) }) });
        const data = await response.json();
        if (data.csrf_token) window.csrf_token = data.csrf_token;
        rejected = !response.ok && response.status >= 400 && response.status < 500;
        if (!response.ok || !Array.isArray(data.results)) throw new Error(data.message || 'Batch failed; check mailbox inventory before retrying.');
        for (const row of pending) {
          const result = data.results.find(result => result.address === row.address);
          row.created = result?.created === true;
          row.unconfirmed = result?.outcome === 'unconfirmed';
          if (row.created) credentials.set(row.address, { address: row.address, name: row.name, password: row.password });
          row.state.textContent = result?.message || 'Not processed';
          row.state.className = row.created ? 'p-bulk-success' : 'p-bulk-error';
        }
        const created = rows.filter(row => row.created).length;
        const unconfirmed = rows.some(row => row.unconfirmed);
        status.textContent = created + ' / ' + rows.length + ' mailboxes created.' + (created ? ' Download the created credentials before leaving.' : '')
          + (unconfirmed ? ' Check mailbox inventory for unconfirmed rows before retrying.' : created < rows.length ? ' See the error beside each remaining mailbox.' : '');
        // Reuse the existing list refresh without reloading or losing generated credentials.
        document.querySelector('[data-p-refresh]')?.click();
      } catch (error) {
        status.textContent = error.message + (rejected ? ' No mailboxes were created by this request.' : ' Check inventory before submitting another batch.');
        rows.forEach(row => { if (!row.created) { row.state.textContent = rejected ? 'Not created. ' + error.message : 'Outcome unconfirmed'; row.state.className = 'p-bulk-error'; } });
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
    const setupDialog = document.querySelector('[data-p-domain-setup]');
    const setupData = new Map(), setupRequests = new Map();
    let setupDomain = '', setupSequence = 0;
    function domainStatus(name, data, failed = false) {
      root.querySelectorAll('[data-p-domain-name]').forEach(status => {
        if (status.dataset.pDomainName !== name) return;
        const enabled = data ? data.enabled : status.dataset.pEnabled === 'true';
        status.textContent = !enabled ? copy.inactive : failed ? 'Check needed' : !data ? 'Checking DNS' : data.ready ? copy.active : 'Setup needed';
        status.className = 'p-status ' + (!enabled ? 'p-status-inactive' : data?.ready ? 'p-status-active' : 'p-status-pending');
      });
    }
    async function checkDomain(name, refresh = false) {
      if (setupRequests.has(name)) {
        if (!refresh) return setupRequests.get(name);
        try { await setupRequests.get(name); } catch (_) { /* An explicit recheck starts a fresh request. */ }
      }
      domainStatus(name, null);
      const request = (async () => {
        try {
          const response = await fetch('/inc/ajax/dns_diagnostics.php?' + new URLSearchParams({ domain: name, format: 'json', ...(refresh ? { refresh: '1' } : {}) }), { credentials: 'same-origin' });
          const data = await response.json();
          if (!response.ok || data.domain !== name || !Array.isArray(data.records) || typeof data.ready !== 'boolean' || typeof data.enabled !== 'boolean') throw new Error(data.message || 'DNS checks are unavailable.');
          if (!data.records.every(record => record && typeof record.name === 'string' && typeof record.type === 'string' && typeof record.expected === 'string'
            && Array.isArray(record.current) && record.current.every(value => typeof value === 'string') && typeof record.required === 'boolean'
            && ['complete', 'missing', 'mismatch', 'unconfirmed'].includes(record.status))) throw new Error('Invalid DNS check response.');
          const required = data.records.filter(record => record.required), complete = required.filter(record => record.status === 'complete').length;
          if (required.length !== data.required || complete !== data.complete || data.ready !== (required.length > 0 && complete === required.length)) throw new Error('Incomplete DNS check response.');
          setupData.set(name, data); domainStatus(name, data);
          return data;
        } catch (error) {
          setupData.delete(name); domainStatus(name, null, true); throw error;
        } finally { setupRequests.delete(name); }
      })();
      setupRequests.set(name, request);
      return request;
    }
    function renderSetup(data) {
      const summary = setupDialog.querySelector('[data-p-setup-summary]');
      summary.textContent = data.complete + ' / ' + data.required + ' required checks complete. '
        + (!data.enabled ? 'This domain is disabled. Enable it in domain settings when ready.' : data.ready ? 'Setup complete. This domain is active.' : 'Setup needed. Complete the required records below.');
      const table = element('table', 'p-dns-table'), header = element('tr');
      for (const label of ['Record', 'Type', 'Expected value', 'Current value', 'Status']) header.append(element('th', '', label));
      const head = element('thead'); head.append(header); table.append(head);
      const body = element('tbody');
      for (const record of data.records) {
        const tr = element('tr'), name = element('td');
        name.append(element('code', '', record.name), element('small', '', record.required ? 'Required' : 'Recommended'));
        tr.append(name, element('td', '', record.type));
        for (const value of [record.expected || 'Could not determine the server address.', record.current.join('\n') || 'No record found']) {
          const td = element('td'); td.append(element('code', '', value)); tr.append(td);
        }
        const state = element('td');
        state.append(element('span', 'p-status ' + (record.status === 'complete' ? 'p-status-active' : 'p-status-pending'), { complete: 'Done', missing: 'Missing', mismatch: 'Needs change', unconfirmed: 'Check needed' }[record.status] || 'Check needed'));
        tr.append(state); body.append(tr);
      }
      table.append(body); setupDialog.querySelector('[data-p-setup-records]').replaceChildren(table);
      setupDialog.querySelector('[data-p-setup-checked]').textContent = 'Last checked ' + new Date(data.checked_at * 1000).toLocaleString() + '. Checks are cached for up to 5 minutes; Recheck DNS checks again now.';
    }
    async function openSetup(name, refresh = false) {
      if (!setupDialog) return;
      setupDomain = name;
      const current = ++setupSequence;
      setupDialog.querySelector('[data-p-setup-domain]').textContent = name;
      setupDialog.querySelector('[data-p-setup-settings]').href = '/edit/domain/' + encodeURIComponent(name);
      if (!setupDialog.open) setupDialog.showModal();
      const panel = setupDialog.querySelector('[data-p-setup-records]'), button = setupDialog.querySelector('[data-p-setup-refresh]');
      panel.setAttribute('aria-busy', 'true'); button.disabled = true;
      setupDialog.querySelector('[data-p-setup-summary]').textContent = 'Checking DNS records…';
      panel.replaceChildren(); setupDialog.querySelector('[data-p-setup-checked]').textContent = '';
      try {
        const data = !refresh && setupData.has(name) && !setupRequests.has(name) ? setupData.get(name) : await checkDomain(name, refresh);
        if (current === setupSequence) renderSetup(data);
      } catch (error) {
        if (current === setupSequence) setupDialog.querySelector('[data-p-setup-summary]').textContent = error.message + ' Use Recheck DNS to try again. This domain has not been confirmed ready.';
      } finally {
        if (current === setupSequence) { panel.setAttribute('aria-busy', 'false'); button.disabled = false; }
      }
    }
    setupDialog?.querySelector('[data-p-setup-refresh]').addEventListener('click', () => openSetup(setupDomain, true));
    async function checkVisibleDomains(items, current) {
      const queue = [...items];
      const worker = async () => {
        while (queue.length && current === sequence && task === 'tab-domains') {
          const item = queue.shift();
          try { await checkDomain(item.domain_name); } catch (_) { /* Each row offers the setup panel and a retry. */ }
        }
      };
      await Promise.all([worker(), worker()]);
    }
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
      if (kind === 'domain' && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(item.domain_name)) {
        const mark = document.createElement('img'); mark.alt = ''; mark.loading = 'lazy'; mark.decoding = 'async'; mark.referrerPolicy = 'no-referrer';
        const candidates = ['favicon.svg', 'favicon.ico', 'favicon.png']; let candidate = 0;
        mark.addEventListener('load', () => identity.firstChild.classList.add('p-domain-icon-loaded'));
        mark.addEventListener('error', () => {
          if (++candidate < candidates.length) mark.src = 'https://' + item.domain_name + '/' + candidates[candidate];
          else mark.remove();
        });
        mark.src = 'https://' + item.domain_name + '/' + candidates[candidate]; identity.firstChild.append(mark);
      }
      const text = element('div');
      const label = kind === 'domain' ? item.domain_h_name || item.domain_name : kind === 'mailbox' ? item.username : item.address;
      const sub = kind === 'domain' ? item.description : kind === 'mailbox' ? item.name : item.goto;
      const target = kind === 'alias' && item.group_id ? '/edit/mailbox-group/' + encodeURIComponent(item.group_id) : '/edit/' + kind + '/' + encodeURIComponent(kind === 'domain' ? item.domain_name : kind === 'mailbox' ? item.username : item.id);
      const link = element('a', 'p-row-title', label);
      link.href = target;
      text.append(link, element('span', 'p-row-subtitle', sub || '—'));
      identity.append(text);
      const status = element(kind === 'domain' ? 'button' : 'span', Number(item.active) === 1 ? 'p-status p-status-active' : 'p-status p-status-inactive', Number(item.active) === 1 ? copy.active : copy.inactive);
      const detail = element('div', 'p-row-detail');
      if (kind === 'mailbox') {
        detail.append(element('span', '', bytes(item.quota_used) + ' / ' + (Number(item.quota) === 0 ? '∞' : bytes(item.quota))), element('div', 'p-storage-meter'));
        const used = Math.min(100, Math.max(0, Number(item.percent_in_use) || 0));
        const fill = element('span'); fill.style.width = used + '%';
        detail.lastChild.append(fill);
        detail.setAttribute('aria-label', copy.storage + ': ' + used + '%');
      } else if (kind === 'domain') {
        status.type = 'button'; status.dataset.pDomainName = item.domain_name; status.dataset.pEnabled = String(Number(item.active) === 1);
        status.className = 'p-status ' + (Number(item.active) === 1 ? 'p-status-pending' : 'p-status-inactive');
        status.textContent = Number(item.active) === 1 ? 'Checking DNS' : copy.inactive;
        status.setAttribute('aria-label', 'Domain setup for ' + label);
        status.addEventListener('click', () => openSetup(item.domain_name));
        const count = element('button', 'p-domain-count', (item.mboxes_in_domain ?? 0) + ' ' + copy.mailboxes);
        count.type = 'button'; count.title = copy.open_mailboxes;
        count.addEventListener('click', () => { domain.value = item.domain_name; saveDomain(); search.value = ''; select('tab-mailboxes', true); });
        detail.append(count, element('span', 'p-row-subtitle', item.quota_used_in_domain == null ? '—' : bytes(item.quota_used_in_domain)));
      } else detail.append(element('span', 'p-row-subtitle', item.public_comment || ''));
      const edit = element('a', 'p-row-open'); edit.href = target; edit.setAttribute('aria-label', copy.edit + ' ' + label); edit.append(icon('arrow-up-right'));
      const actions = element('div', 'p-row-actions');
      if (kind === 'domain') {
        const setup = element('button', 'btn btn-sm btn-info p-domain-setup-link'); setup.type = 'button';
        setup.setAttribute('aria-label', 'DNS setup for ' + label); setup.title = 'DNS setup';
        setup.append(icon('globe2'), element('span', '', 'DNS'));
        setup.addEventListener('click', () => openSetup(item.domain_name)); actions.append(setup);
      }
      actions.append(edit);
      node.append(identity, detail, status, actions);
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
        if (kind === 'domain') void checkVisibleDomains(rows, current);
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
    try {
      const added = sessionStorage.getItem('plates:setup-domain'); sessionStorage.removeItem('plates:setup-domain');
      if (added && Array.from(domain.options).some(option => option.value === added)) void openSetup(added);
    } catch (_) {}
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
    let hostTimer, mailTimer, hostRequest = null, mailRequest = null, disposed = false, lastMail = 0, lastResponse = 0;
    let history = [];
    const live = (label, good, detail) => {
      const status = root.querySelector('[data-p-live-status]');
      status.textContent = label; status.className = 'p-status ' + (good ? 'p-status-active' : 'p-status-pending');
      root.querySelector('[data-p-live-updated]').textContent = detail;
    };
    const percent = value => {
      if (value == null || value === '') return null;
      const number = Number(value); return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
    };
    const gib = value => value != null && Number.isFinite(Number(value)) ? (Number(value) / 1073741824).toFixed(1) + ' GiB' : '—';
    const svgNode = (tag, attributes) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, value] of Object.entries(attributes || {})) node.setAttribute(key, String(value));
      return node;
    };
    function drawHistory() {
      const end = history.at(-1)?.time || 0, span = Math.max(30, end - (history[0]?.time || end));
      root.querySelectorAll('[data-p-host-chart]').forEach(chart => {
        const key = chart.dataset.pHostChart, points = history.filter(sample => sample[key] !== null);
        if (!points.length) { chart.replaceChildren(text('span', '', 'No measured samples yet')); return; }
        const ceiling = key === 'pressure' ? Math.max(1, ...points.map(point => point[key])) : 100;
        const svg = svgNode('svg', { viewBox: '0 0 240 64', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
        for (const y of [16, 32, 48]) svg.append(svgNode('line', { x1: 0, x2: 240, y1: y, y2: y, class: 'p-spark-grid' }));
        let segment = [], segments = [], previous = null;
        for (const sample of history) {
          if (sample[key] === null || previous !== null && sample.time - previous > 15) {
            if (segment.length) segments.push(segment); segment = [];
          }
          if (sample[key] !== null) segment.push([240 * (sample.time - (end - span)) / span, 60 - 56 * sample[key] / ceiling]);
          previous = sample.time;
        }
        if (segment.length) segments.push(segment);
        for (const values of segments) {
          if (values.length > 1) {
            const line = values.map(([x, y], index) => (index ? 'L' : 'M') + x.toFixed(2) + ',' + y.toFixed(2)).join(' ');
            svg.append(svgNode('path', { d: line + ' L' + values.at(-1)[0].toFixed(2) + ',64 L' + values[0][0].toFixed(2) + ',64 Z', fill: 'currentColor', opacity: .1 }));
            svg.append(svgNode('path', { d: line, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
          }
        }
        const latest = points.at(-1), x = 240 * (latest.time - (end - span)) / span, y = 60 - 56 * latest[key] / ceiling;
        svg.append(svgNode('circle', { cx: x, cy: y, r: 2.5, fill: 'currentColor' }));
        const duration = Math.round(end - history[0].time), values = points.map(point => point[key]);
        chart.setAttribute('aria-label', key + ' history: ' + values.length + ' measured samples; minimum ' + Math.min(...values).toFixed(2) + '%, maximum ' + Math.max(...values).toFixed(2) + '%');
        chart.replaceChildren(svg, text('small', '', duration < 60 ? duration + ' seconds observed' : Math.floor(duration / 60) + ' min ' + duration % 60 + ' sec observed'));
      });
    }
    function renderHost(host = {}, generatedAt, services) {
      const responseAt = Number(generatedAt) || Date.now() / 1000;
      const at = Number(host.sampled_at) || responseAt;
      if (responseAt < lastResponse || responseAt === lastResponse && at < (history.at(-1)?.time || 0)) return;
      lastResponse = responseAt;
      const available = host.available !== false;
      const cpu = available ? percent(host.cpu?.usage) : null, memory = available ? percent(host.memory?.usage) : null;
      const pressure = available ? percent(host.memory_pressure?.some?.avg10) : null, storage = percent(host.storage?.usage_percent);
      const values = {
        cpu: cpu === null ? '—' : cpu.toFixed(1) + '%', cores: cpu === null ? 'Host telemetry unavailable' : host.cpu.cores + ' logical cores',
        memory: memory === null ? '—' : memory.toFixed(1) + '%', memory_available: memory === null ? 'Unavailable' : gib(host.memory.available) + ' available / ' + gib(host.memory.total),
        pressure: pressure === null ? '—' : pressure.toFixed(2) + '%', storage: storage === null ? '—' : storage.toFixed(1) + '%',
        storage_available: storage === null ? 'Unavailable' : gib(host.storage.available_bytes) + ' available / ' + gib(host.storage.total_bytes),
        uptime: available && Number.isFinite(Number(host.uptime)) ? Math.floor(host.uptime / 86400) + 'd ' + Math.floor(host.uptime % 86400 / 3600) + 'h' : '—',
      };
      root.querySelectorAll('[data-p-host]').forEach(el => { el.textContent = values[el.dataset.pHost] ?? '—'; });
      if (!history.length || at > history.at(-1).time) {
        history.push({ time: at, cpu, memory, pressure, storage });
        history = history.filter(sample => sample.time >= at - 300).slice(-120); drawHistory();
      }
      live(cpu !== null && memory !== null ? 'Live · every 5 seconds' : 'Host telemetry unavailable', cpu !== null && memory !== null,
        'Last checked ' + new Date(responseAt * 1000).toLocaleTimeString());
      const list = root.querySelector('[data-p-services]');
      if (Array.isArray(services)) list.replaceChildren(...services.map(service => {
        const item = text('li', '', ''), healthy = service.running && (!service.health || service.health === 'healthy');
        item.append(text('span', '', service.name), text('span', 'p-status ' + (healthy ? 'p-status-active' : 'p-status-pending'), !service.running ? 'Stopped' : service.health === 'unhealthy' ? 'Unhealthy' : service.health === 'starting' ? 'Starting' : 'Running'));
        return item;
      }));
      else if (services === null) list.querySelectorAll('.p-status').forEach(status => { status.textContent = 'Unknown'; status.className = 'p-status p-status-inactive'; });
    }
    function scheduleHost() {
      clearTimeout(hostTimer);
      if (!disposed && !document.hidden) hostTimer = setTimeout(loadHost, 5000);
    }
    async function loadHost() {
      if (disposed || document.hidden || hostRequest) return;
      hostRequest = new AbortController(); const started = performance.now();
      const timeout = setTimeout(() => hostRequest?.abort(new DOMException('Stats request timed out', 'TimeoutError')), 20000);
      try {
        const response = await fetch('/api/v1/get/overview/server', { credentials: 'same-origin', cache: 'no-store', signal: hostRequest.signal });
        if (!response.ok) throw new Error('Stats unavailable');
        const data = await response.json();
        if (!data.server || typeof data.server !== 'object') throw new Error('Invalid stats');
        if (!disposed && !document.hidden) {
          renderHost(data.server, data.generated_at, data.services);
          root.querySelector('[data-p-api-time]').textContent = Math.round(performance.now() - started) + ' ms';
        }
      } catch (error) {
        if (error.name !== 'AbortError' && !disposed && !document.hidden) {
          live('Reconnecting…', false, 'Live stats are unavailable. Retrying in 5 seconds.');
          root.querySelectorAll('[data-p-host="cpu"], [data-p-host="memory"], [data-p-host="pressure"], [data-p-host="storage"], [data-p-host="uptime"]').forEach(el => { el.textContent = '—'; });
          root.querySelectorAll('[data-p-host="cores"], [data-p-host="memory_available"], [data-p-host="storage_available"]').forEach(el => { el.textContent = 'Unavailable'; });
          const at = Date.now() / 1000;
          if (at > (history.at(-1)?.time || 0)) {
            history.push({ time: at, cpu: null, memory: null, pressure: null, storage: null });
            history = history.filter(sample => sample.time >= at - 300).slice(-120); drawHistory();
          }
          root.querySelectorAll('[data-p-services] .p-status').forEach(status => { status.textContent = 'Unknown'; status.className = 'p-status p-status-inactive'; });
        }
      } finally { clearTimeout(timeout); hostRequest = null; scheduleHost(); }
    }
    const load = async () => {
      if (mailRequest || disposed || document.hidden) return;
      clearTimeout(mailTimer); mailRequest = new AbortController();
      button.disabled = true; root.setAttribute('aria-busy', 'true');
      const started = performance.now();
      try {
        const response = await fetch('/api/v1/get/overview', { credentials: 'same-origin', cache: 'no-store', signal: mailRequest.signal });
        if (!response.ok) throw new Error('Unavailable');
        const data = await response.json();
        if (!data.counts || !data.inventory || !Array.isArray(data.hourly) || !data.coverage) throw new Error('Invalid metrics');
        renderHost(data.server, data.generated_at, data.services);
        lastMail = Date.now();
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
      } catch (error) {
        if (error.name === 'AbortError') return;
        root.querySelector('[data-p-coverage]').textContent = copy.error;
        root.querySelectorAll('[data-p-timing]').forEach(el => { el.textContent = '—'; });
        root.querySelectorAll('[data-p-metric], [data-p-inventory]').forEach(el => { el.textContent = '—'; });
        root.querySelector('[data-p-activity]').replaceChildren();
        root.querySelector('[data-p-activity-times]').replaceChildren();
        root.querySelectorAll('[data-p-ranking]').forEach(list => list.replaceChildren(text('li', 'p-ranking-empty', copy.error)));
      } finally {
        mailRequest = null; button.disabled = false; root.setAttribute('aria-busy', 'false');
        if (!disposed && !document.hidden) { mailTimer = setTimeout(load, 60000); if (!hostRequest) scheduleHost(); }
      }
    };
    button.addEventListener('click', load);
    document.addEventListener('visibilitychange', () => {
      clearTimeout(hostTimer); clearTimeout(mailTimer);
      if (document.hidden) { hostRequest?.abort(); mailRequest?.abort(); live('Paused', false, 'Live updates resume when this tab is visible.'); }
      else { loadHost(); if (Date.now() - lastMail >= 60000) load(); else mailTimer = setTimeout(load, Math.max(1000, 60000 - (Date.now() - lastMail))); }
    });
    window.addEventListener('pagehide', () => { disposed = true; clearTimeout(hostTimer); clearTimeout(mailTimer); hostRequest?.abort(); mailRequest?.abort(); });
    window.addEventListener('pageshow', event => { if (event.persisted) { disposed = false; load(); } });
    loadHost();
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
