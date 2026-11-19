/* Progressive presentation only. mailcow/Bootstrap keep ownership of data and writes. */
(() => {
  'use strict';
  if (!document.body.classList.contains('plates-ui')) return;

  function start() {
    const reveal = () => document.documentElement.removeAttribute('data-plates-pending');
    const $ = window.jQuery;
    const main = document.querySelector('body > .container.flex-grow-1');
    if (main) {
      document.querySelector('.plates-content-anchor')?.remove();
      main.id = 'plates-main';
      main.setAttribute('role', 'main');
      main.tabIndex = -1;
    }
    if (document.querySelector('[data-p-workspace]')) return;
    const mail = document.getElementById('mail-content');
    if (!mail || !$ || !window.bootstrap?.Tab) { reveal(); return; }
    const tabs = mail.querySelector(':scope > [role="tablist"]');
    const copy = JSON.parse(document.getElementById('plates-mail-copy').textContent);
    const heading = document.querySelector('[data-plates-mail-heading]');
    const domainFilter = document.querySelector('[data-plates-domain-filter]');
    const domainSelect = document.querySelector('[data-plates-domain]');
    // Keep our picker native; upstream enhances every select on document ready.
    if ($.fn.selectpicker) $(domainSelect).selectpicker('destroy');
    const primaryAction = document.createElement('div');
    primaryAction.className = 'plates-primary-action';
    heading.append(primaryAction);
    const domainKey = 'plates:domain:' + location.pathname + ':' + (domainFilter.dataset.platesUser || '');
    let selectedDomain = '';
    try { const saved = localStorage.getItem(domainKey); if (Array.from(domainSelect.options).some(option => option.value === saved)) selectedDomain = domainSelect.value = saved; } catch (_) {}
    const saveDomain = () => { try { localStorage.setItem(domainKey, selectedDomain); } catch (_) {} };

    // Move the original buttons, preserving upstream listeners and every permitted tool.
    // Only the three daily tasks sit at the top level; the rest stay under More tools.
    const primary = ['tab-domains', 'tab-mailboxes', 'tab-mbox-aliases'];
    const buttons = [...tabs.querySelectorAll('button[data-bs-toggle="tab"]')];
    const available = buttons.filter(button => {
      const item = button.closest('.nav-item');
      return !item?.classList.contains('d-none') &&
        !(window.role !== 'admin' && button.dataset.bsTarget === '#tab-tls-policy');
    });
    const moreItem = document.createElement('li');
    moreItem.className = 'nav-item dropdown';
    moreItem.setAttribute('role', 'presentation');
    const moreToggle = document.createElement('button');
    moreToggle.type = 'button';
    moreToggle.className = 'nav-link dropdown-toggle';
    moreToggle.dataset.bsToggle = 'dropdown';
    moreToggle.setAttribute('aria-expanded', 'false');
    moreToggle.textContent = copy.more;
    const moreMenu = document.createElement('ul');
    moreMenu.className = 'dropdown-menu';
    moreItem.append(moreToggle, moreMenu);
    const fragments = [];
    for (const id of primary) {
      const button = available.find(item => item.dataset.bsTarget === '#' + id);
      if (!button) continue;
      const item = document.createElement('li');
      item.className = 'nav-item';
      item.setAttribute('role', 'presentation');
      button.classList.remove('dropdown-item');
      button.classList.add('nav-link');
      item.append(button);
      fragments.push(item);
    }
    for (const button of available) {
      const id = button.dataset.bsTarget.slice(1);
      button.id = 'plates-tab-' + id;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', id);
      document.getElementById(id)?.setAttribute('aria-labelledby', button.id);
      if (primary.includes(id)) continue;
      const group = button.closest('.nav-item');
      const groupName = group?.querySelector(':scope > .dropdown-toggle')?.textContent.trim();
      if (groupName) button.textContent = groupName + ' · ' + button.textContent.trim();
      button.classList.remove('nav-link');
      button.classList.add('dropdown-item');
      const item = document.createElement('li');
      item.setAttribute('role', 'presentation');
      item.append(button);
      moreMenu.append(item);
    }
    if (moreMenu.children.length) fragments.push(moreItem);
    tabs.replaceChildren(...fragments);
    tabs.classList.add('plates-mail-tabs');
    mail.classList.add('plates-mail-ready');

    const findButton = id => available.find(button => button.dataset.bsTarget === '#' + id);
    function sync(id) {
      const button = findButton(id);
      if (!button) return;
      const panel = document.getElementById(id);
      heading.querySelector('[data-plates-title]').textContent = button.textContent.trim();
      const kind = id === 'tab-domains' ? 'domains' : id === 'tab-mailboxes' ? 'mailboxes' :
        ['tab-mbox-aliases', 'tab-domain-aliases'].includes(id) ? 'aliases' : 'tools';
      heading.querySelector('[data-plates-description]').textContent = copy[kind];
      moreToggle.classList.toggle('active', !primary.includes(id));
      for (const link of document.querySelectorAll('.plates-rail [data-plates-tab]')) {
        if (link.dataset.platesTab === id) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
      domainFilter.hidden = id !== 'tab-mailboxes';
      primaryAction.replaceChildren();
      const modalId = id === 'tab-domains' ? '#addDomainModal' : id === 'tab-mailboxes' ? '#addMailboxModal' : null;
      const originalAdd = modalId && panel?.querySelector('[data-bs-target="' + modalId + '"]');
      if (originalAdd) {
        // The button only exists when the upstream template permits this action.
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'btn btn-primary';
        action.dataset.bsToggle = 'modal';
        action.dataset.bsTarget = modalId;
        const icon = document.createElement('i');
        icon.className = 'bi bi-plus-lg';
        icon.setAttribute('aria-hidden', 'true');
        action.append(icon, document.createTextNode(' ' + originalAdd.textContent.trim()));
        primaryAction.append(action);
      }
      // Desktop tab changes must also reveal mailcow's nested accordion body.
      const body = panel?.querySelector('.card-body.collapse');
      if (body) window.bootstrap.Collapse.getOrCreateInstance(body, { toggle: false }).show();
      if ($.fn.dataTable) $.fn.dataTable.tables({ visible: true, api: true }).columns.adjust().responsive.recalc();
    }
    function open(id) {
      id = { domains: 'tab-domains', mailboxes: 'tab-mailboxes', aliases: 'tab-mbox-aliases' }[id] || id;
      const button = findButton(id);
      if (!button) return false;
      window.bootstrap.Tab.getOrCreateInstance(button).show();
      sync(id);
      return true;
    }
    function setHash(id, push) {
      const url = new URL(window.location.href);
      url.hash = id;
      if (url.href !== window.location.href) window.history[push ? 'pushState' : 'replaceState'](null, '', url);
    }
    $(tabs).on('shown.bs.tab', 'button[data-bs-toggle="tab"]', function () {
      const id = this.dataset.bsTarget.slice(1);
      sync(id);
      setHash(id, true);
    });
    document.addEventListener('click', event => {
      const link = event.target.closest('a[data-plates-tab]');
      if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = new URL(link.href, window.location.href);
      if (target.pathname !== window.location.pathname || !findButton(link.dataset.platesTab)) return;
      event.preventDefault();
      open(link.dataset.platesTab);
      setHash(link.dataset.platesTab, true);
      // Bootstrap restores focus to the menu trigger after its drawer closes.
      const rail = document.getElementById('plates-navigation');
      if (rail?.classList.contains('show')) window.bootstrap.Offcanvas.getInstance(rail)?.hide();
    });
    window.addEventListener('popstate', () => open(window.location.hash.slice(1) || 'tab-domains'));
    window.addEventListener('hashchange', () => open(window.location.hash.slice(1) || 'tab-domains'));

    // Apply the exact server-side domain filter before the first lazy table request.
    // Search, sort, pagination and role restrictions still run in mailcow's SSP endpoint.
    $.ajaxPrefilter(options => {
      if (options.url.split('?')[0] !== '/api/v1/search/mailbox' || !selectedDomain) return;
      const data = JSON.parse(options.data);
      data.domain = selectedDomain;
      options.data = JSON.stringify(data);
    });
    const reloadMailboxes = () => {
      if ($.fn.dataTable?.isDataTable('#mailbox_table')) $('#mailbox_table').DataTable().ajax.reload(null, true);
    };
    domainSelect.addEventListener('change', () => {
      selectedDomain = domainSelect.value;
      saveDomain();
      reloadMailboxes();
    });
    document.querySelector('[data-plates-clear-domain]').addEventListener('click', () => {
      selectedDomain = '';
      domainSelect.value = '';
      saveDomain();
      reloadMailboxes();
      domainSelect.focus();
    });
    $(document).on('xhr.dt.plates', '#domain_table, #mailbox_table', (event, settings, json) => {
      if (!json || !Number.isFinite(Number(json.recordsTotal))) return;
      const kind = settings.nTable.id === 'domain_table' ? 'domains' : 'mailboxes';
      // Summary totals represent the workspace, not a filtered page of results.
      if (kind === 'mailboxes' && selectedDomain) return;
      document.querySelector('[data-plates-count="' + kind + '"]').textContent = json.recordsTotal;
    });

    const requested = window.location.hash.slice(1);
    const current = available.find(button => button.classList.contains('active'));
    if (!open(requested)) open(current?.dataset.bsTarget.slice(1) || 'tab-domains');
    reveal();
  }
  // Register after upstream ready handlers, including its remembered-tab restoration.
  if (window.jQuery) window.jQuery(() => window.setTimeout(start, 0));
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
