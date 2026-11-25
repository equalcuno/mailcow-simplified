<?php
/** Exercise the real footer with mixed notification groups, without a database or web session. */
set_error_handler(static function ($severity, $message) {
    if (error_reporting() & $severity) throw new RuntimeException($message);
    return false;
});
function logger() {}
function alertbox_log_parser($session) { return $session['test_logs']; }
$hash = 'mailcow-alert-check-'.bin2hex(random_bytes(8));
$cache = '/tmp/'.$hash.'.js';
file_put_contents($cache, '');
$js_minifier = new class($hash) {
    public function __construct(private string $hash) {}
    public function getDataHash() { return $this->hash; }
};
$twig = new class {
    public array $globals = [];
    public function addGlobal($name, $value) { $this->globals[$name] = $value; }
};
$tfa = new class { public function createSecret() { return 'fixture'; } };
$lang = array_fill_keys(['footer', 'acl', 'tfa', 'fido2', 'success', 'danger', 'syncjobs', 'groups'], []);
foreach (['MAILCOW_GIT_VERSION', 'MAILCOW_LAST_GIT_VERSION', 'MAILCOW_GIT_OWNER', 'MAILCOW_GIT_REPO', 'MAILCOW_GIT_URL', 'MAILCOW_GIT_COMMIT', 'MAILCOW_GIT_COMMIT_DATE', 'MAILCOW_BRANCH', 'MAILCOW_UPDATEDAT'] as $name) $GLOBALS[$name] = '';
$DOCKER_TIMEOUT = $SESSION_LIFETIME = $PAGINATION_SIZE = $LOG_PAGINATION_SIZE = 1;
$template_data = null;
$_SESSION = ['CSRF' => ['TOKEN' => 'fixture'], 'return' => [], 'test_logs' => [
    ['type' => '"success"', 'msg' => 'DKIM key example.org has been saved'],
    ['type' => '"success"', 'msg' => 'DKIM key example.org has been saved'],
    ['type' => '"warning"', 'msg' => 'Domain added but SOGo restart failed'],
    ['type' => '"warning"', 'msg' => 'Check DNS <records>'],
    ['type' => '"danger"', 'msg' => 'A separate error'],
]];
try {
    require dirname(__DIR__, 2).'/data/web/inc/footer.inc.php';
    $alerts = $twig->globals['alerts'];
    if (count($alerts) !== 3 || count(array_filter($alerts, 'is_string')) !== 3) throw new RuntimeException('Every severity must render a message string');
    if (substr_count($alerts['success'], 'DKIM key') !== 1) throw new RuntimeException('Repeated messages must be deduplicated within their severity');
    if (!str_contains($alerts['warning'], 'SOGo restart failed') || !str_contains($alerts['warning'], 'Check DNS &lt;records&gt;')) throw new RuntimeException('Warnings must survive alongside success messages and remain escaped');
    if (!str_contains($alerts['danger'], 'separate error') || isset($_SESSION['return'])) throw new RuntimeException('Errors must survive and notifications must be consumed');
    echo "Notifications: mixed severities, deduplication and escaping passed.\n";
} finally {
    unlink($cache);
    restore_error_handler();
}
