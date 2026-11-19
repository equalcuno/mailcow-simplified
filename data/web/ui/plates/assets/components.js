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
    if (overviewRoot) overview(overviewRoot);
  };

  function workspace(root) {
    const copy = JSON.parse(document.getElementById('p-workspace-copy').textContent);
    const results = root.querySelector('[data-p-results]');
    const search = root.querySelector('[data-p-search]');
    const domain = root.querySelector('[data-p-domain]');
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
        count.addEventListener('click', () => { domain.value = item.domain_name; search.value = ''; select('tab-mailboxes', true); });
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
    domain.addEventListener('change', () => { page = 0; load(); });
    root.querySelector('[data-p-refresh]').addEventListener('click', load);
    root.querySelector('[data-p-previous]').addEventListener('click', () => { page--; load(); });
    root.querySelector('[data-p-next]').addEventListener('click', () => { page++; load(); });
    create.addEventListener('click', () => {
      const dialog = document.getElementById('p-create-' + tasks[task].kind);
      if (dialog) { dialog.querySelector('form').reset(); dialog.showModal(); }
    });
    let remembered; try { remembered = sessionStorage.getItem('plates-task:' + location.pathname); } catch (_) {}
    select(taskFromFragment(location.hash.slice(1)) || remembered || 'tab-domains');
  }
  function overview(root) {
    const copy = JSON.parse(document.getElementById('p-overview-copy').textContent);
    const button = root.querySelector('[data-p-overview-refresh]');
    const format = new Intl.NumberFormat();
    const date = time => new Date(time * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const text = (tag, className, value) => { const el = document.createElement(tag); if (className) el.className = className; el.textContent = value; return el; };
    const load = async () => {
      button.disabled = true; root.setAttribute('aria-busy', 'true');
      try {
        const response = await fetch('/api/v1/get/overview', { credentials: 'same-origin' });
        if (!response.ok) throw new Error('Unavailable');
        const data = await response.json();
        if (!data.counts || !data.inventory || !Array.isArray(data.hourly) || !data.coverage) throw new Error('Invalid metrics');
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
        root.querySelectorAll('[data-p-metric], [data-p-inventory]').forEach(el => { el.textContent = '—'; });
        root.querySelector('[data-p-activity]').replaceChildren();
        root.querySelector('[data-p-activity-times]').replaceChildren();
        root.querySelectorAll('[data-p-ranking]').forEach(list => list.replaceChildren(text('li', 'p-ranking-empty', copy.error)));
      } finally { button.disabled = false; root.setAttribute('aria-busy', 'false'); }
    };
    button.addEventListener('click', load);
    load();
  }
  if (window.jQuery) window.jQuery(() => setTimeout(start, 0));
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
