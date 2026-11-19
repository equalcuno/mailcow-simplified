<?php
if (getenv('WEBMAIL_CLIENT') === 'sogo') { require __DIR__.'/legacy-sogo-auth.php'; exit; }
require_once $_SERVER['DOCUMENT_ROOT'].'/inc/prerequisites.inc.php';
use Mailcow\Ui\WebmailAccess;

protect_route(['user', 'admin', 'domainadmin']);
if (isset($_GET['logout'])) {
    // Roundcube redirects here after ending its own session. Mirror the portal's
    // logout (sessions.inc.php): a cross-site link must not end someone's session.
    if (($_SERVER['HTTP_SEC_FETCH_SITE'] ?? 'same-origin') === 'cross-site') {
        header('Location: /');
        exit;
    }
    unset($_SESSION['webmail_login_as'], $_SESSION['sogo-sso-user-allowed'], $_SESSION['sogo-sso-pass']);
    $panel = ['admin' => '/admin/mailbox', 'domainadmin' => '/domainadmin/mailbox'];
    if (isset($_SESSION['dual-login'])) {
        // Admin "login as" a user: return to the administrator's own session.
        $_SESSION['mailcow_cc_username'] = $_SESSION['dual-login']['username'];
        $_SESSION['mailcow_cc_role'] = $_SESSION['dual-login']['role'];
        unset($_SESSION['dual-login']);
        header('Location: '.($panel[$_SESSION['mailcow_cc_role']] ?? '/'));
        exit;
    }
    $role = $_SESSION['mailcow_cc_role'];
    if (isset($panel[$role])) {
        // An administrator opened a mailbox from the panel; keep the admin session.
        header('Location: '.$panel[$role]);
        exit;
    }
    session_regenerate_id(true);
    session_unset();
    session_destroy();
    session_write_close();
    header('Location: /');
    exit;
}
$target = isset($_GET['login']) && is_string($_GET['login']) ? $_GET['login'] : WebmailAccess::target($_SESSION);
$actor = WebmailAccess::actor($_SESSION);
$inScope = filter_var($target, FILTER_VALIDATE_EMAIL)
    && hasMailboxObjectAccess($actor['username'], $actor['role'], $target);
$details = $inScope ? WebmailAccess::details($pdo, $target) : [];
$adminLogin = preg_match('/^(y|yes)$/i', getenv('ALLOW_ADMIN_EMAIL_LOGIN') ?: 'n') === 1;
if (!WebmailAccess::allowed($_SESSION, is_array($details) ? $details : [], $target, $inScope, $adminLogin)) {
    http_response_code(403);
    exit('Webmail access is not permitted for this mailbox.');
}
$_SESSION['webmail_login_as'] = $target;
header('Location: /webmail/');
