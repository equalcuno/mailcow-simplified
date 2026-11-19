<?php
// This bare FastCGI parameter is set only on nginx's internal loopback listener.
// HTTP headers with the same spelling cannot authorize a request.
if (($_SERVER['WEBMAIL_AUTH_INTERNAL'] ?? '') !== '1') {
    http_response_code(404);
    exit;
}
require_once $_SERVER['DOCUMENT_ROOT'].'/inc/prerequisites.inc.php';
use Mailcow\Ui\WebmailAccess;

header('Cache-Control: no-store');
$target = WebmailAccess::target($_SESSION);
$actor = WebmailAccess::actor($_SESSION);
$inScope = filter_var($target, FILTER_VALIDATE_EMAIL)
    && hasMailboxObjectAccess($actor['username'], $actor['role'], $target);
$details = $inScope ? WebmailAccess::details($pdo, $target) : [];
$adminLogin = preg_match('/^(y|yes)$/i', getenv('ALLOW_ADMIN_EMAIL_LOGIN') ?: 'n') === 1;
if (!WebmailAccess::allowed($_SESSION, is_array($details) ? $details : [], $target, $inScope, $adminLogin)) {
    http_response_code(empty($_SESSION['mailcow_cc_role']) ? 401 : 403);
    exit;
}
$password = @file_get_contents('/etc/sogo-sso/sogo-sso.pass');
if (!is_string($password) || !preg_match('/^[a-z0-9]{32}$/', $password)) {
    http_response_code(503);
    exit;
}
header('X-Auth: Basic '.base64_encode($target.':'.$password));
session_write_close();
