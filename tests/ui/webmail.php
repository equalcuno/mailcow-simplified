<?php
/** Regression checks for the portal boundary and Roundcube account switching. */
require dirname(__DIR__, 2).'/data/web/inc/lib/mailcow/Ui/WebmailAccess.php';
require dirname(__DIR__, 2).'/data/web/inc/lib/mailcow/Mailbox/BatchCreator.php';
use Mailcow\Ui\WebmailAccess;
$checks = 0;
function verify(bool $condition, string $message): void {
    global $checks;
    if (!$condition) throw new RuntimeException($message);
    $checks++;
}
$session = ['mailcow_cc_role' => 'user', 'mailcow_cc_username' => 'alex@example.org'];
$mailbox = ['username' => 'alex@example.org', 'active' => 1, 'domain_active' => 1,
            'attributes' => ['sogo_access' => 1]];
$allowed = static fn($s, $m = null, $scope = true, $admin = false) =>
    WebmailAccess::allowed($s, $m ?? $mailbox, 'alex@example.org', $scope, $admin);
verify($allowed($session), 'A normal mailbox session can access its own webmail');
verify(!$allowed([]), 'Anonymous access is denied');
foreach (['pending_tfa_setup', 'pending_pw_update', 'mailcow_cc_api'] as $flag) {
    verify(!$allowed(array_merge($session, [$flag => true])), "$flag blocks SSO");
}
verify(!$allowed($session, array_merge($mailbox, ['active' => 0])), 'Disabled mailbox is denied');
verify(!$allowed($session, array_merge($mailbox, ['domain_active' => 0])), 'Disabled domain is denied');
verify(!$allowed($session, array_merge($mailbox, ['username' => 'other@example.org'])), 'Mailbox identity is bound');
verify(!$allowed($session, array_merge($mailbox, ['attributes' => ['sogo_access' => 0]])), 'Webmail access flag is enforced');
verify(!$allowed($session, array_merge($mailbox, ['attributes' => ['sogo_access' => 1, 'force_pw_update' => 1]])), 'Password reset is enforced');
verify(!$allowed($session, null, false), 'Scope is required for ordinary users too');
$admin = ['mailcow_cc_role' => 'domainadmin', 'mailcow_cc_username' => 'manager', 'acl' => ['login_as' => 1]];
verify($allowed($admin, null, true, true), 'Authorized administrator can impersonate an in-scope mailbox');
verify(!$allowed($admin), 'Administrator impersonation is disabled by default');
verify(!$allowed($admin, null, false, true), 'Domain administrators cannot cross domains');
verify(!$allowed(array_merge($admin, ['acl' => []]), null, true, true), 'login_as permission is required');
$dual = array_merge($session, ['dual-login' => ['username' => 'manager', 'role' => 'domainadmin'], 'acl' => ['login_as' => 1]]);
verify(!$allowed($dual), 'Dual-login does not bypass the administrator setting');
verify($allowed($dual, null, true, true), 'Authorized dual-login is permitted');
verify(!$allowed($dual, null, false, true), 'Dual-login retains original tenant scope');
verify(WebmailAccess::target($session) === 'alex@example.org', 'User target is the session identity');
verify(WebmailAccess::target(array_merge($admin, ['webmail_login_as' => 'alex@example.org'])) === 'alex@example.org', 'Admin target is explicitly selected');

$row = ['local_part' => 'Alex', 'domain' => 'example.org', 'name' => 'Alex', 'password' => str_repeat('ab', 16), 'quota' => 1024];
$batch = \Mailcow\Mailbox\BatchCreator::prepare([$row]);
verify($batch[0]['local_part'] === 'alex' && $batch[0]['password'] === $batch[0]['password2'], 'Batch preserves passwords and normalizes addresses');
verify($batch[0]['sogo_access'] === 1 && $batch[0]['authsource'] === 'mailcow', 'Batch uses normal webmail/authentication defaults');
foreach ([[], array_fill(0, 51, $row), [$row, $row], [array_merge($row, ['password' => []])],
          [array_merge($row, ['local_part' => '../invalid'])]] as $invalid) {
    $rejected = false;
    try { \Mailcow\Mailbox\BatchCreator::prepare($invalid); } catch (InvalidArgumentException $error) { $rejected = true; }
    verify($rejected, 'Malformed, duplicate or excessive batches are rejected before any creation callback');
}
$mixed = \Mailcow\Mailbox\BatchCreator::prepare([
    array_merge($row, ['local_part' => 'short', 'password' => 'weak']),
    $row,
    array_merge($row, ['local_part' => 'quota', 'quota' => -1]),
]);
verify(str_contains($mixed[0]['validation_error'], 'minimum 16'), 'A short password has a specific row error');
verify(!isset($mixed[1]['validation_error']) && $mixed[1]['password'] === $row['password'], 'Valid rows survive another row failing validation');
verify(str_contains($mixed[2]['validation_error'], 'Quota'), 'Invalid quotas have a specific row error');

// Roundcube plugin test doubles: no real mail services or credentials.
class rcube_plugin { public function add_hook(...$args) {} }
class FakeSession { public function remove($key) { unset($_SESSION[$key]); } }
class FakeConfig {
    public $values = ['imap_host' => '172.22.1.250:143'];
    public function get($key, $default = null) { return $this->values[$key] ?? $default; }
}
class rcmail {
    public static $instance;
    public $session;
    public $config;
    public $shutdown = [];
    public $killed = 0;
    public static function get_instance() { return self::$instance ??= new self(); }
    public function __construct() { $this->session = new FakeSession(); $this->config = new FakeConfig(); }
    public function kill_session() { $_SESSION = []; $this->killed++; }
    public function encrypt($value) { return 'encrypted:'.$value; }
    public function add_shutdown_function($fn) { $this->shutdown[] = $fn; }
}
require dirname(__DIR__, 2).'/data/conf/roundcube/plugins/mailcow_sso/mailcow_sso.php';
$plugin = new mailcow_sso();
$_SERVER['PHP_AUTH_USER'] = 'alex@example.org';
$_SERVER['PHP_AUTH_PW'] = 'internal-fixture-credential';
$_SESSION = [];
verify($plugin->startup([])['action'] === 'login', 'Portal credentials initiate Roundcube login');
$auth = $plugin->authenticate(['user' => 'attacker@example.org', 'pass' => 'injected', 'host' => 'attacker.invalid']);
verify($auth['user'] === 'alex@example.org' && $auth['host'] === '172.22.1.250:143', 'SSO overwrites user-controlled credentials and uses the configured IPv4 IMAP host');
$_SESSION = ['user_id' => 1, 'username' => 'other@example.org', 'password' => 'old'];
$plugin->startup([]);
verify(rcmail::get_instance()->killed === 1 && empty($_SESSION['user_id']), 'Switching accounts kills the prior inbox session');
$_SESSION = ['user_id' => 1, 'username' => 'alex@example.org'];
$plugin->startup([]);
verify($_SESSION['password'] === 'encrypted:internal-fixture-credential', 'Live credential is refreshed after Dovecot rotation');
foreach (rcmail::get_instance()->shutdown as $callback) $callback();
verify(!isset($_SESSION['password']), 'Shared internal credential is not persisted in the Roundcube session');
unset($_SERVER['PHP_AUTH_USER'], $_SERVER['PHP_AUTH_PW']);
verify(!$plugin->authenticate([])['valid'], 'Missing trusted credentials fail closed');
// Roundcube logout must also end the portal session, or SSO signs straight back in.
verify(mailcow_sso::logout_target('/webmail.php?logout=1') === '/webmail.php?logout=1', 'Logout hands over to the portal logout');
foreach (['https://evil.example/', '//evil.example/', '/\\evil.example/', "/x\r\nSet-Cookie: a=b", '', null, ['/']] as $unsafe) {
    verify(mailcow_sso::logout_target($unsafe) === null, 'Logout never redirects off-site or splits headers');
}
echo "Webmail: $checks checks passed.\n";
