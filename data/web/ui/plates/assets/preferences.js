(() => {
  // Keep the earliest background in step with mailcow's existing theme control.
  const theme = () => document.documentElement.toggleAttribute('data-plates-dark', !!document.getElementById('dark-mode-theme'));
  new MutationObserver(theme).observe(document.head, { childList: true });
  const start = () => {
    const settings = document.getElementById('p-preferences');
    if (!settings) return;
    const form = settings.querySelector('[data-p-preferences]');
    const value = name => [...form.querySelectorAll('input[name="' + name + '"]')].find(input => input.checked)?.value;
    const sync = () => { form.querySelector('[data-p-component-options]').disabled = value('ui') !== 'plates'; };
    sync();
    form.addEventListener('change', sync);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const url = new URL(window.location.href);
      url.searchParams.set('ui', value('ui'));
      if (value('ui') === 'plates') url.searchParams.set('components', value('components'));
      url.hash = 'tab-ui';
      window.location.assign(url.href);
    });
    const tabs = document.getElementById('admin-content');
    if (!tabs || !window.bootstrap?.Tab) return;
    const restore = () => {
      const target = window.location.hash;
      const button = [...tabs.querySelectorAll('[data-bs-toggle="tab"]')].find(button => button.dataset.bsTarget === target);
      if (button) window.bootstrap.Tab.getOrCreateInstance(button).show();
    };
    restore();
    window.addEventListener('hashchange', restore);
    window.jQuery?.(tabs).on('shown.bs.tab', '[data-bs-toggle="tab"]', function () {
      const url = new URL(location.href); url.hash = this.dataset.bsTarget;
      history.replaceState(null, '', url);
    });
  };
  if (window.jQuery) window.jQuery(() => setTimeout(start, 0));
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
