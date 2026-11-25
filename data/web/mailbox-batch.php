<?php
require_once $_SERVER['DOCUMENT_ROOT'].'/inc/prerequisites.inc.php';
header('Content-Type: application/json');
header('Cache-Control: no-store');
if (!in_array($_SESSION['mailcow_cc_role'] ?? '', ['admin', 'domainadmin'], true)
    || !empty($_SESSION['mailcow_cc_api']) || !empty($_SESSION['pending_tfa_setup'])
    || !empty($_SESSION['pending_pw_update']) || $DEMO_MODE) {
    http_response_code(403); echo json_encode(['message' => 'An administrator session is required.']); exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405); header('Allow: POST'); echo json_encode(['message' => 'Use POST.']); exit;
}
$body = file_get_contents('php://input', false, null, 0, 262145);
$request = strlen($body) <= 262144 ? json_decode($body, true) : null;
if (!is_array($request) || !is_string($request['csrf_token'] ?? null)
    || !hash_equals((string)($_SESSION['CSRF']['TOKEN'] ?? ''), $request['csrf_token'])
    || empty($_SESSION['CSRF']['TOKEN'])) {
    http_response_code(403); echo json_encode(['message' => 'Refresh the page before creating mailboxes.']); exit;
}
try {
    $rows = \Mailcow\Mailbox\BatchCreator::prepare($request['rows'] ?? []);
    // Preflight every domain boundary before any mailbox is created.
    foreach ($rows as $row) {
        if (!hasDomainAccess($_SESSION['mailcow_cc_username'], $_SESSION['mailcow_cc_role'], $row['domain'])) {
            http_response_code(403); echo json_encode(['message' => 'One or more domains are outside your permissions.']); exit;
        }
    }
} catch (\InvalidArgumentException | \TypeError $e) {
    http_response_code(422); echo json_encode(['message' => 'Invalid mailbox batch. '.$e->getMessage()]); exit;
}
$results = [];
foreach ($rows as $row) {
    $address = $row['local_part'].'@'.$row['domain'];
    if (isset($row['validation_error'])) {
        $results[] = ['address' => $address, 'created' => false, 'message' => 'Not created. '.$row['validation_error']];
        continue;
    }
    $_SESSION['return'] = [];
    try {
        $ok = mailbox('add', 'mailbox', $row) !== false;
        $messages = $_SESSION['return'] ?? [];
        $errors = array_values(array_filter($messages, static fn($message) => in_array($message['type'] ?? '', ['danger', 'error'], true)));
        if ($errors) $ok = false;
        $details = $errors ? array_column(alertbox_log_parser(['return' => $errors]) ?: [], 'msg') : [];
        $results[] = ['address' => $address, 'created' => $ok,
                      'message' => $ok ? 'Created' : 'Not created. '.($details ? implode(' ', $details) : 'Check domain limits, password policy, or whether the mailbox already exists.')];
    } catch (\Throwable $e) {
        $results[] = ['address' => $address, 'created' => false, 'outcome' => 'unconfirmed',
                      'message' => 'Outcome unconfirmed. Check mailbox inventory before retrying this row.'];
        // Stop on an unexpected failure; do not blindly retry a possibly committed operation.
        break;
    }
}
unset($_SESSION['return']);
$_SESSION['CSRF']['TOKEN'] = bin2hex(random_bytes(32));
$_SESSION['CSRF']['TIME'] = time();
echo json_encode(['results' => $results, 'csrf_token' => $_SESSION['CSRF']['TOKEN']]);
