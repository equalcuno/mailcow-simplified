<?php
if (getenv('WEBMAIL_CLIENT') === 'sogo') { require __DIR__.'/legacy-sogo-auth.php'; exit; }
require_once $_SERVER['DOCUMENT_ROOT'].'/inc/prerequisites.inc.php';
use Mailcow\Ui\WebmailAccess;

protect_route(['user', 'admin', 'domainadmin']);
if (isset($_GET['logout'])) {
    unset($_SESSION['webmail_login_as']);
    $role = $_SESSION['mailcow_cc_role'];
    header('Location: '.($role === 'user' ? '/user' : ($role === 'admin' ? '/admin/mailbox' : '/domainadmin/mailbox')));
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
