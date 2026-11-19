<?php
/** Render real Twig templates without databases or a running mail stack. */
error_reporting(E_ALL & ~E_DEPRECATED);
$root = dirname(__DIR__, 2);
$_SERVER['DOCUMENT_ROOT'] = $root.'/data/web';
$_SERVER['HTTPS'] = 'on';
$_GET = $_COOKIE = [];
$_SESSION = ['mailcow_locale' => 'en-gb'];
$DEV_MODE = false;
require $root.'/data/web/inc/lib/vendor/autoload.php';
$language = json_decode(file_get_contents($root.'/data/web/lang/lang.en-gb.json'), true);
$output = getenv('PLATES_PREVIEW_DIR') ?: sys_get_temp_dir().'/mailcow-plates-preview';
if (!is_dir($output)) mkdir($output, 0777, true);
$checks = 0;
function check(bool $condition, string $message): void {
  global $checks;
  if (!$condition) throw new RuntimeException($message);
  $checks++;
}
function renderFixture(string $template, string $role, string $path, string $presentation = 'plates', array $extra = [], string $components = 'original'): string {
  global $language, $DEV_MODE, $root;
  $UI_PRESENTATION = $presentation;
  $UI_COMPONENTS = $components;
  $_SERVER['REQUEST_URI'] = $path;
  require $root.'/data/web/inc/twig.inc.php';
  $twig->setCache(false);
  $acl = array_fill_keys(array_keys($language['acl']), 1);
  $context = [
    'lang' => $language, 'mailcow_locale' => 'en-gb',
    'available_languages' => ['en-gb' => 'English', 'de-de' => 'Deutsch'],
    'mailcow_cc_role' => $role, 'mailcow_cc_username' => $role ? ($role === 'user' ? 'alex@example.org' : 'admin') : '',
    'is_master' => true, 'dual_login' => false, 'is_root_uri' => $path === '/',
    'ui_texts' => ['main_name' => 'mailcow', 'title_name' => 'mailcow', 'apps_name' => 'Apps'],
    'css_path' => '/fixtures/mailcow.css', 'js_path' => '/fixtures/mailcow.js',
    'dark_css_path' => '/css/themes/mailcow-darkmode.css',
    'logo' => '/img/cow_mailcow.svg', 'logo_dark' => '/img/cow_mailcow.svg',
    'mailcow_apps_processed' => [['name' => 'Webmail', 'user_link' => '/SOGo', 'description' => 'Webmail']],
    'acl' => $acl, 'acl_json' => json_encode($acl), 'role' => $role,
    'is_dual' => 'false', 'allow_admin_email_login' => 'false',
    'csrf_token' => 'fixture-csrf-token', 'pagination_size' => 25,
    'session_lifetime' => 3600, 'docker_timeout' => 5,
    'domains' => ['example.org', 'studio.co.za'],
    'mailboxes' => ['alex@example.org', 'hello@example.org', 'ops@studio.co.za'],
    'global_filters' => [], 'alerts' => [], 'app_links' => [], 'app_links_processed' => [],
    'mailcow_info' => [], 'pending_tfa_methods' => [], 'pending_tfa_authmechs' => [],
    'quota' => 1073741824, 'quota_used' => 104857600, 'percent_in_use' => 10,
    'result' => [], 'mailbox_details' => [], 'iam_settings' => [],
    'dkim_domains' => [], 'dkim' => [], 'dkim_keys' => [], 'domains_without_dkim' => [], 'dkim_blind_domains' => [],
    'totp_secret' => 'FIXTURE', 'max_mailboxes' => 100, 'max_aliases' => 100,
    'return_to' => '/admin/mailbox#tab-mailboxes',
    'hostname' => 'mail.dev.test',
    'containers' => ['postfix-mailcow' => ['State' => ['Running' => true]], 'dovecot-mailcow' => ['State' => ['Running' => true]], 'rspamd-mailcow' => ['State' => ['Running' => true]]],
  ];
  foreach (['footer', 'acl', 'tfa', 'fido2', 'success', 'danger', 'mailbox', 'syncjobs', 'groups', 'ratelimit', 'edit', 'datatables', 'user', 'admin', 'debug', 'quarantine', 'queue'] as $key) {
    $context['lang_'.$key] = json_encode($language[$key] ?? []);
  }
  $context['lang_rl'] = json_encode($language['ratelimit']);
  $context['js_path'] = $template === 'mailbox.twig' ? '/fixtures/mailcow.js' : ($template === 'edit/mailbox.twig' ? '/fixtures/edit.js' : '/fixtures/base.js');
  return $twig->render($template, array_replace($context, $extra));
}

// Preference inputs are allowlisted and remain separate from identity/roles.
require_once $root.'/data/web/ui/plates/presentation.php';
check(mailcow_plates_presentation('plates')['enabled'], 'Plates is the fork default');
check(!mailcow_plates_presentation('stock')['enabled'], 'Stock configuration bypasses the overrides');
$_GET['ui'] = ['plates'];
check(!mailcow_plates_presentation('stock')['enabled'], 'Array input cannot select a presentation');
$_GET['ui'] = '../../etc/passwd';
check(!mailcow_plates_presentation('stock')['enabled'], 'Untrusted paths cannot select a presentation');
$_GET = [];
$_COOKIE['mailcow_presentation'] = 'stock';
check(!mailcow_plates_presentation()['enabled'], 'Browser preference persists');
$_GET['ui'] = 'plates';
check(mailcow_plates_presentation('stock')['enabled'], 'Explicit switch overrides the browser preference');
$_GET = $_COOKIE = [];

$mail = renderFixture('mailbox.twig', 'admin', '/admin/mailbox');
$stock = renderFixture('mailbox.twig', 'admin', '/admin/mailbox', 'stock');
check(str_contains($mail, 'plates-rail'), 'Plates shell rendered');
check(!str_contains($stock, '/ui/plates/assets/plates.css'), 'Stock bypass has no Plates styling');
check(!str_contains($stock, 'data-p-appearance'), 'No floating Appearance control remains');
foreach (['domain_table', 'mailbox_table', 'addMailboxModal', 'addDomainModal', 'csrf_token', 'logout'] as $contract) {
  check(str_contains($mail, $contract) && str_contains($stock, $contract), 'Retained upstream contract: '.$contract);
}
preg_match_all('/data-id="([^"]+)"/', $stock, $stockIds);
preg_match_all('/data-id="([^"]+)"/', $mail, $platesIds);
check($stockIds[1] === $platesIds[1], 'Every upstream form/action data-id survives template inheritance');
file_put_contents($output.'/admin.html', $mail);
file_put_contents($output.'/stock.html', $stock);
file_put_contents($output.'/admin-original.html', $mail);

$domainAdmin = renderFixture('mailbox.twig', 'domainadmin', '/domainadmin/mailbox');
preg_match('/<aside\b.*?<\/aside>/s', $domainAdmin, $nav);
check(!str_contains($nav[0], '/admin/system') && !str_contains($nav[0], '/admin/dashboard'), 'Domain administrator navigation has no administrator routes');
check(str_contains($nav[0], '/domainadmin/mailbox'), 'Domain administrator navigation stays in its scope');
file_put_contents($output.'/domainadmin.html', $domainAdmin);
file_put_contents($output.'/domainadmin-original.html', $domainAdmin);
$restricted = renderFixture('mailbox.twig', 'domainadmin', '/domainadmin/mailbox', 'plates', ['acl' => ['mailbox_groups' => 0]]);
check(!str_contains($restricted, 'data-plates-tab="tab-groups"'), 'Group navigation follows ACL');
$user = renderFixture('base.twig', 'user', '/user');
preg_match('/<aside\b.*?<\/aside>/s', $user, $nav);
check(!str_contains($nav[0], '/admin/') && !str_contains($nav[0], '/domainadmin/'), 'Mailbox user navigation has no management routes');
file_put_contents($output.'/user.html', $user);
$escaped = renderFixture('base.twig', 'user', '/user', 'plates', ['mailcow_cc_username' => '<img src=x onerror=alert(1)>']);
check(!str_contains($escaped, '<strong><img'), 'Untrusted identity text is escaped');

$details = ['name' => 'Alex Morgan', 'username' => 'alex@example.org', 'active' => 1, 'authsource' => 'mailcow', 'quota' => 5368709120, 'max_new_quota' => 10737418240, 'tags' => [], 'attributes' => []];
$extra = ['mailbox' => 'alex@example.org', 'result' => $details, 'mailbox_details' => $details];
$edit = renderFixture('edit/mailbox.twig', 'admin', '/edit/mailbox/alex%40example.org', 'plates', $extra);
$stockEdit = renderFixture('edit/mailbox.twig', 'admin', '/edit/mailbox/alex%40example.org', 'stock', $extra);
preg_match_all('/name="([^"]+)"/', $stockEdit, $stockNames);
preg_match_all('/name="([^"]+)"/', $edit, $platesNames);
check($stockNames[1] === $platesNames[1], 'All mailbox edit inputs survive, including advanced fields');
check(str_contains($edit, 'data-id="editmailbox"'), 'Native mailbox save handler retained');
file_put_contents($output.'/edit.html', $edit);
file_put_contents($output.'/edit-original.html', $edit);
foreach ([['dashboard.twig', 'dashboard', '/admin/dashboard'], ['admin.twig', 'settings', '/admin/system'], ['quarantine.twig', 'quarantine', '/quarantine'], ['queue.twig', 'queue', '/admin/queue'], ['user_index.twig', 'login', '/']] as [$template, $name, $path]) {
  $html = renderFixture($template, $name === 'login' ? '' : 'admin', $path);
  check(str_contains($html, '/ui/plates/assets/plates.css'), $name.' uses Plates');
  if ($name === 'login') check(!str_contains($html, 'id="plates-navigation"'), 'Guests never see management navigation');
  file_put_contents($output.'/'.$name.'.html', $html);
  if (in_array($name, ['login', 'settings', 'dashboard'], true)) file_put_contents($output.'/'.$name.'-original.html', $html);
}
$_SESSION['mailcow_locale'] = 'de-de';
check(mailcow_plates_presentation()['text']['overview'] === 'Übersicht', 'German presentation copy is loaded');
$_SESSION['mailcow_locale'] = 'en-gb';
$_COOKIE['mailcow_components'] = 'original';
check(mailcow_plates_presentation()['components'] === 'original', 'Component preference persists independently');
$_GET['components'] = 'redesigned';
check(mailcow_plates_presentation()['components'] === 'redesigned', 'Component switch overrides its cookie');
$_GET = $_COOKIE = [];
foreach ([['mailbox.twig', 'admin', '/admin/mailbox', 'admin'], ['mailbox.twig', 'domainadmin', '/domainadmin/mailbox', 'domainadmin'], ['user_index.twig', '', '/', 'login'], ['admin_index.twig', '', '/admin', 'login-admin'], ['domainadmin_index.twig', '', '/domainadmin', 'login-domainadmin'], ['edit/mailbox.twig', 'admin', '/edit/mailbox/alex%40example.org', 'edit'], ['dashboard.twig', 'admin', '/admin/dashboard', 'dashboard'], ['admin.twig', 'admin', '/admin/system', 'settings']] as [$template, $role, $path, $name]) {
  $html = renderFixture($template, $role, $path, 'plates', $name === 'edit' ? $extra : [], 'redesigned');
  check(str_contains($html, '/assets/components.css'), $name.' loads redesigned components');
  if ($template === 'mailbox.twig') check(str_contains($html, 'data-p-workspace'), $name.' renders its own workspace');
  if ($name === 'login-admin') {
    check(str_contains($html, 'Sign in with passkey') && str_contains($html, 'id="fido2-login"'), 'Admin passkey button uses the existing WebAuthn hook');
    check(str_contains($html, 'name="login_user"') && str_contains($html, 'name="pass_user"'), 'Admin login retains authentication field contracts');
    check(!str_contains($html, 'class="card login-card'), 'Redesigned login uses its own composition');
  }
  file_put_contents($output.'/'.$name.'.html', $html);
}
foreach (['user_index.twig' => ['login', '/'], 'admin_index.twig' => ['login-admin', '/admin'], 'domainadmin_index.twig' => ['login-domainadmin', '/domainadmin'], 'admin.twig' => ['settings', '/admin/system']] as $template => [$name, $path]) {
  file_put_contents($output.'/'.$name.'-stock.html', renderFixture($template, $name === 'settings' ? 'admin' : '', $path, 'stock'));
  file_put_contents($output.'/'.$name.'-original.html', renderFixture($template, $name === 'settings' ? 'admin' : '', $path));
}
$settings = file_get_contents($output.'/settings.html');
check(str_contains($settings, 'id="tab-ui"') && str_contains($settings, 'name="ui_favicon"'), 'Settings UI tab exposes appearance and favicon controls');
check(!str_contains(file_get_contents($output.'/login.html'), 'p-branding-settings'), 'Branding mutation controls are absent from login');
$branded = renderFixture('admin_index.twig', '', '/admin', 'plates', ['ui_texts' => ['main_name' => 'Acme &amp; Co', 'title_name' => 'Acme'], 'logo' => '/img/company.png'], 'redesigned');
check(str_contains($branded, 'Acme &amp; Co') && str_contains($branded, 'src="/img/company.png"'), 'Business name and logo replace the generic brand mark');
check(!str_contains($branded, 'Acme &amp;amp; Co'), 'Stored business names are decoded and safely escaped once');
$sso = renderFixture('user_index.twig', '', '/', 'plates', ['custom_login' => ['force_sso' => 1], 'has_iam_sso' => true], 'redesigned');
check(!str_contains($sso, 'name="pass_user"') && str_contains($sso, '/?iam_sso=1'), 'Forced SSO remains enforced in the new login');
$pending = renderFixture('admin_index.twig', 'admin', '/admin', 'plates', ['pending_tfa_setup' => true], 'redesigned');
check(str_contains($pending, '<body class="plates-ui plates-guest">'), 'Pending MFA uses the login layout without a phantom sidebar offset');
check(str_contains($pending, 'id="WebAuthnModal"'), 'Native MFA dialogs remain present for pending administrators');

// The optional domain constraint uses PDO parameters and composes with domain-admin ACLs.
// Run the real SSP builder against SQLite to verify scope and parameter semantics.
if (extension_loaded('pdo_sqlite')) {
  require $root.'/data/web/inc/lib/ssp.class.php';
  $db = new PDO('sqlite::memory:');
  $db->exec('CREATE TABLE mailbox (username TEXT, domain TEXT, kind TEXT); CREATE TABLE domain_admins (username TEXT, domain TEXT, active INTEGER)');
  $db->exec("INSERT INTO mailbox VALUES ('alex@example.org','example.org',''), ('wrong@example.org.evil','example.org.evil',''), ('ops@studio.co.za','studio.co.za','')");
  $db->exec("INSERT INTO domain_admins VALUES ('manager','example.org',1)");
  $request = ['draw' => 1, 'start' => 0, 'length' => 25, 'search' => ['value' => ''], 'columns' => [['data' => 0, 'searchable' => 'true', 'orderable' => 'true', 'search' => ['value' => '']]], 'order' => []];
  $columns = [['db' => 'username', 'dt' => 0]];
  $filter = \Mailcow\Mailbox\MailboxSearchScope::forCaller('admin', 'admin', 'example.org');
  $rows = SSP::complex($request, $db, ['mailbox', 'm'], 'username', $columns, null, $filter);
  check(count($rows['data']) === 1 && $rows['data'][0][0] === 'alex@example.org', 'Exact domain scope excludes suffix matches');
  $filter = \Mailcow\Mailbox\MailboxSearchScope::forCaller('domainadmin', 'manager', 'studio.co.za');
  $rows = SSP::complex($request, $db, ['mailbox', 'm'], 'username', $columns, 'INNER JOIN domain_admins AS da ON da.domain = m.domain', $filter);
  check(count($rows['data']) === 0, 'Domain filter cannot expand domain-admin access');
  $filter = \Mailcow\Mailbox\MailboxSearchScope::forCaller('domainadmin', 'manager', "example.org' OR 1=1 --");
  $rows = SSP::complex($request, $db, ['mailbox', 'm'], 'username', $columns, 'INNER JOIN domain_admins AS da ON da.domain = m.domain', $filter);
  check(count($rows['data']) === 0, 'Domain filter remains a bound value');
  $filter = \Mailcow\Mailbox\MailboxSearchScope::forCaller('admin', 'admin');
  $rows = SSP::complex($request, $db, ['mailbox', 'm'], 'username', $columns, null, $filter);
  check(count($rows['data']) === 3, 'Requests without a domain retain their original scope');
  try {
    \Mailcow\Mailbox\MailboxSearchScope::forCaller('user', 'alex@example.org', 'example.org');
    check(false, 'Mailbox users must not get a management search scope');
  } catch (InvalidArgumentException $e) {
    check(true, 'Mailbox users cannot get a management search scope');
  }
} else {
  throw new RuntimeException('pdo_sqlite is required for the domain-scope regression checks');
}
echo "Plates: $checks render/scope checks passed. Preview: $output\n";
