<?php
require_once $_SERVER['DOCUMENT_ROOT'].'/inc/prerequisites.inc.php';
header('Content-Type: application/json');
header('Cache-Control: no-store');
if (($_SESSION['mailcow_cc_role'] ?? '') !== 'admin' || !empty($_SESSION['mailcow_cc_api'])
    || !empty($_SESSION['pending_tfa_setup']) || !empty($_SESSION['pending_pw_update'])) {
    http_response_code(403); echo json_encode(['message' => 'An administrator session is required.']); exit;
}
try {
    $activeAdmin = $pdo->prepare('SELECT 1 FROM admin WHERE username = :username AND active = 1 AND superadmin = 1');
    $activeAdmin->execute([':username' => $_SESSION['mailcow_cc_username']]);
    if (!$activeAdmin->fetchColumn()) {
        http_response_code(403); echo json_encode(['message' => 'An active administrator account is required.']); exit;
    }
    $heartbeat = json_decode($redis->get('SIMPLIFIED_UPDATE_HEARTBEAT') ?: '{}', true);
    $status = json_decode($redis->get('SIMPLIFIED_UPDATE_STATUS') ?: '{}', true);
    $online = is_array($heartbeat) && (int)($heartbeat['at'] ?? 0) > time() - 45;
    $busy = $redis->exists('SIMPLIFIED_UPDATE_LOCK') > 0;
    $candidate = $heartbeat['candidate'] ?? null;
    if (!is_string($candidate) || !preg_match('/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/D', $candidate)) $candidate = null;
    $ready = $online && !empty($heartbeat['ready']) && !$DEMO_MODE;
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        $message = $busy ? ($status['message'] ?? 'An upgrade is queued or running.')
            : (!$online ? 'Host update service is offline. See the installation guide.'
                : ($status['message'] ?? $heartbeat['message'] ?? 'No update is available.'));
        echo json_encode(['ready' => $ready, 'busy' => $busy, 'candidate' => $candidate,
                          'message' => $message, 'job' => $status, 'csrf_token' => $_SESSION['CSRF']['TOKEN']]);
        exit;
    }
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405); header('Allow: GET, POST'); echo json_encode(['message' => 'Use GET or POST.']); exit;
    }
    $raw = file_get_contents('php://input', false, null, 0, 4097);
    $request = strlen($raw) <= 4096 ? json_decode($raw, true) : null;
    if (!is_array($request) || !is_string($request['csrf_token'] ?? null) || empty($_SESSION['CSRF']['TOKEN'])
        || !hash_equals($_SESSION['CSRF']['TOKEN'], $request['csrf_token'])) {
        http_response_code(403); echo json_encode(['message' => 'Refresh the page before requesting an update.']); exit;
    }
    if (!$ready || !$candidate || $candidate !== ($request['commit'] ?? null)) {
        http_response_code(409); echo json_encode(['message' => 'The release or update service changed. Refresh and review again.']); exit;
    }
    $job = ['id' => bin2hex(random_bytes(16)), 'commit' => $candidate,
            'requested_by' => $_SESSION['mailcow_cc_username'], 'requested_at' => time()];
    $queued = ['id' => $job['id'], 'phase' => 'queued', 'message' => 'Update queued. The host will verify prerequisites before pausing mail access.'];
    $script = "if redis.call('exists',KEYS[1])==1 then return 0 end "
        ."redis.call('set',KEYS[1],ARGV[1],'EX',86400) "
        ."redis.call('set',KEYS[2],ARGV[2],'EX',600) "
        ."redis.call('set',KEYS[3],ARGV[3]) return 1";
    $ok = $redis->eval($script, ['SIMPLIFIED_UPDATE_LOCK', 'SIMPLIFIED_UPDATE_QUEUE', 'SIMPLIFIED_UPDATE_STATUS',
                                $job['id'], json_encode($job), json_encode($queued)], 3);
    if ((int)$ok !== 1) {
        http_response_code(409); echo json_encode(['message' => 'Another update is already queued or running.']); exit;
    }
    $_SESSION['CSRF']['TOKEN'] = bin2hex(random_bytes(32));
    $_SESSION['CSRF']['TIME'] = time();
    http_response_code(202);
    echo json_encode(['message' => $queued['message'], 'id' => $job['id'], 'csrf_token' => $_SESSION['CSRF']['TOKEN']]);
} catch (Throwable $e) {
    http_response_code(503); echo json_encode(['message' => 'Unable to confirm the update request. Check the update status before trying again.']);
}
