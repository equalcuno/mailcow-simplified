<?php
/** Exercise real HTTP controllers with isolated session/mailbox/cache doubles. */
$root = dirname(__DIR__, 2);
$dir = sys_get_temp_dir().'/mailcow-request-check-'.bin2hex(random_bytes(8));
mkdir($dir.'/inc/ajax', 0700, true);
$bootstrap = <<<'PHP'
<?php
session_start();
$_SESSION = ['mailcow_cc_role' => $_SERVER['HTTP_X_TEST_ROLE'] ?? 'admin',
            'mailcow_cc_username' => 'manager', 'CSRF' => ['TOKEN' => 'fixture-csrf']];
$DEMO_MODE = false;
$mailcow_hostname = 'mail.example.org';
$autodiscover_config = [];
foreach (['smtp' => [465, 587], 'imap' => [993, 143], 'pop3' => [995, 110], 'sieve' => [4190, 4190]] as $service => $ports) {
    $autodiscover_config[$service] = ['server' => $mailcow_hostname, 'port' => $ports[0], 'tlsport' => $ports[1]];
}
$lang['diagnostics'] = array_fill_keys(['dns_records_name', 'dns_records_type', 'dns_records_data', 'dns_records_status'], 'fixture');
function hasDomainAccess($user, $role, $domain) { return $domain === 'example.org'; }
function mailbox($action, $type, $row) {
    if ($action === 'get') return match ($type) {
        'alias_domains', 'mta_sts' => [],
        'domain_details' => $row === 'example.org' ? ['active' => 1] : false,
        default => false,
    };
    file_put_contents(__DIR__.'/calls.jsonl', json_encode($row['local_part'])."\n", FILE_APPEND);
    if ($row['local_part'] === 'uncertain') throw new RuntimeException('Injected connection failure');
    if ($row['local_part'] === 'policy') {
        $_SESSION['return'][] = ['type' => 'danger', 'msg' => 'Password must contain a special character.'];
        return false;
    }
    return true;
}
function alertbox_log_parser($data) { return $data['return']; }
function dkim($action, $domain) {
    return ($_SERVER['HTTP_X_TEST_DNS'] ?? '') === 'no-dkim' ? [] : ['dkim_selector' => 'dkim', 'pubkey' => 'PUBLICKEY', 'dkim_txt' => 'v=DKIM1; p=PUBLICKEY'];
}
function dns_get_record($name, $type) {
    $scenario = $_SERVER['HTTP_X_TEST_DNS'] ?? '';
    if ($type === DNS_A && $name === 'mail.example.org') return [['ip' => '192.0.2.10']];
    if ($type === DNS_PTR) return [['target' => 'mail.example.org']];
    if ($type === DNS_MX) return $scenario === 'missing-mx' ? [] : ($scenario === 'resolver-error' ? false : [['target' => 'mail.example.org', 'pri' => 10]]);
    if ($type === DNS_TXT) {
        if ($name === 'example.org') return [['txt' => 'v=spf1 mx -all']];
        if ($name === '_dmarc.example.org') return [['txt' => 'v=DMARC1; p=reject']];
        if ($name === 'dkim._domainkey.example.org') return [['txt' => 'v=DKIM1; p=PUBLICKEY']];
    }
    return [];
}
function get_spf_allowed_hosts($domain, $expand) { return ($_SERVER['HTTP_X_TEST_DNS'] ?? '') === 'spf-denied' ? [] : ['192.0.2.10']; }
$redis = new class {
    public function get($key) {
        file_put_contents(__DIR__.'/cache-reads', 'read');
        if ($key === 'DOMAIN_SETUP_PUBLIC_IPS_V1') return json_encode(['192.0.2.10', '']);
        return json_encode(['domain' => 'example.org', 'enabled' => false, 'ready' => false, 'records' => [], 'required' => 1, 'complete' => 0, 'checked_at' => 123]);
    }
    public function setex($key, $ttl, $data) {}
};
PHP;
$bootstrap .= "\nrequire ".var_export($root.'/data/web/inc/lib/mailcow/Mailbox/BatchCreator.php', true).";\nrequire ".var_export($root.'/data/web/inc/lib/mailcow/Ui/DomainSetup.php', true).";\n";
file_put_contents($dir.'/inc/prerequisites.inc.php', $bootstrap);
file_put_contents($dir.'/inc/spf.inc.php', '<?php');
copy($root.'/data/web/mailbox-batch.php', $dir.'/mailbox-batch.php');
copy($root.'/data/web/inc/ajax/dns_diagnostics.php', $dir.'/inc/ajax/dns_diagnostics.php');
$socket = stream_socket_server('tcp://127.0.0.1:0');
$address = stream_socket_get_name($socket, false);
fclose($socket);
$process = proc_open([PHP_BINARY, '-d', 'disable_functions=dns_get_record', '-S', $address, '-t', $dir], [['pipe', 'r'], ['file', $dir.'/server.log', 'a'], ['file', $dir.'/server.log', 'a']], $pipes);
if (!is_resource($process)) throw new RuntimeException('Cannot start test server');
$checks = 0;
function verify(bool $condition, string $message): void {
    global $checks;
    if (!$condition) throw new RuntimeException($message);
    $checks++;
}
function request(string $path, ?array $body = null, string $role = 'admin', string $dns = 'complete'): array {
    global $address;
    $context = stream_context_create(['http' => ['method' => $body === null ? 'GET' : 'POST',
        'header' => "Content-Type: application/json\r\nX-Test-Role: $role\r\nX-Test-DNS: $dns\r\n", 'content' => $body === null ? '' : json_encode($body),
        'ignore_errors' => true, 'timeout' => 3]]);
    $response = file_get_contents('http://'.$address.$path, false, $context);
    preg_match('/\s(\d{3})\s/', $http_response_header[0], $match);
    return [(int)$match[1], json_decode($response, true, 512, JSON_THROW_ON_ERROR)];
}
function calls(): array {
    global $dir;
    $file = $dir.'/inc/calls.jsonl';
    $calls = is_file($file) ? array_map('json_decode', file($file, FILE_IGNORE_NEW_LINES)) : [];
    if (is_file($file)) unlink($file);
    return $calls;
}
$row = static fn($local, $password = 'LongFixturePassword123!') => ['local_part' => $local, 'domain' => 'example.org', 'name' => $local, 'password' => $password, 'quota' => 1024];
$batch = static fn($rows) => ['csrf_token' => 'fixture-csrf', 'rows' => $rows];
try {
    for ($attempt = 0; $attempt < 100; $attempt++) {
        $probe = @stream_socket_client('tcp://'.$address, $code, $message, 0.05);
        if ($probe) { fclose($probe); break; }
        usleep(20000);
    }
    [$status, $data] = request('/mailbox-batch.php', $batch([$row('short', 'weak'), $row('valid')]));
    verify($status === 200 && !$data['results'][0]['created'] && $data['results'][1]['created'], 'A short password does not prevent the next valid mailbox from being created');
    verify(str_contains($data['results'][0]['message'], 'minimum 16') && calls() === ['valid'], 'Invalid rows show precise errors and never reach the mailbox writer');
    verify($data['csrf_token'] !== 'fixture-csrf', 'Partial success rotates the CSRF token');
    [$status, $data] = request('/mailbox-batch.php', $batch([$row('policy'), $row('valid')]));
    verify(!$data['results'][0]['created'] && str_contains($data['results'][0]['message'], 'special character') && $data['results'][1]['created'], 'Native password-policy errors are shown per row and later rows proceed');
    calls();
    [$status, $data] = request('/mailbox-batch.php', $batch([$row('uncertain'), $row('later')]));
    verify($data['results'][0]['outcome'] === 'unconfirmed' && calls() === ['uncertain'], 'An unexpected write failure is unconfirmed and stops subsequent writes');
    foreach ([
        [$batch([$row('valid'), array_merge($row('foreign'), ['domain' => 'blocked.example'])]), 403],
        [$batch([$row('duplicate'), $row('duplicate')]), 422],
        [$batch([$row('malformed', [])]), 422],
        [['csrf_token' => 'wrong', 'rows' => [$row('valid')]], 403],
    ] as [$payload, $expected]) {
        [$status, $data] = request('/mailbox-batch.php', $payload);
        verify($status === $expected && calls() === [], 'Batch structure, scope and CSRF are checked before any write');
    }
    [$status] = request('/mailbox-batch.php', $batch([$row('valid')]), 'user');
    verify($status === 403 && calls() === [], 'Mailbox users cannot create batches');
    [$status, $data] = request('/inc/ajax/dns_diagnostics.php?format=json&domain=example.org');
    verify($status === 200 && $data['enabled'] === true && $data['ready'] === false, 'Cached DNS results use the current enabled state without inventing readiness');
    [$status, $data] = request('/inc/ajax/dns_diagnostics.php?format=json&domain=example.org&refresh=1');
    verify($status === 200 && $data['ready'] && $data['required'] === 6 && $data['complete'] === 6, 'Fresh diagnostics compute readiness from host, PTR, MX, SPF, DKIM and DMARC records');
    foreach (['missing-mx', 'no-dkim', 'spf-denied', 'resolver-error'] as $scenario) {
        [$status, $data] = request('/inc/ajax/dns_diagnostics.php?format=json&domain=example.org&refresh=1', null, 'domainadmin', $scenario);
        verify($status === 200 && !$data['ready'] && $data['complete'] < $data['required'], 'Incomplete or unconfirmed DNS cannot mark a domain ready for either administrator role');
    }
    unlink($dir.'/inc/cache-reads');
    foreach ([['blocked.example', 'domainadmin', 403], ['example.org', 'user', 403], ['bad%2Fdomain', 'admin', 422]] as [$domain, $role, $expected]) {
        [$status] = request('/inc/ajax/dns_diagnostics.php?format=json&domain='.$domain, null, $role);
        verify($status === $expected && !is_file($dir.'/inc/cache-reads'), 'DNS diagnostics authorize and validate the domain before consulting the cache');
    }
    echo "Mailbox/DNS requests: $checks checks passed.\n";
} finally {
    fclose($pipes[0]); proc_terminate($process); proc_close($process);
    foreach ([$dir.'/inc/ajax/dns_diagnostics.php', $dir.'/inc/prerequisites.inc.php', $dir.'/inc/spf.inc.php', $dir.'/inc/calls.jsonl', $dir.'/inc/cache-reads', $dir.'/mailbox-batch.php', $dir.'/server.log'] as $file) if (is_file($file)) unlink($file);
    rmdir($dir.'/inc/ajax'); rmdir($dir.'/inc'); rmdir($dir);
}
