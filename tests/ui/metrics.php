<?php
/** Backend regression checks for Overview and instance branding; no running services. */
require dirname(__DIR__, 2).'/data/web/inc/lib/vendor/autoload.php';
use Mailcow\Ui\OverviewStats;
use Mailcow\Ui\Branding;
$checks = 0;
function verify(bool $condition, string $description): void {
  global $checks;
  if (!$condition) throw new RuntimeException($description);
  $checks++;
}
function fails(callable $operation, string $description): void {
  try { $operation(); } catch (Throwable $e) { verify(true, $description); return; }
  verify(false, $description);
}
$now = 1794924000;
$event = static fn(string $program, string $message, int $offset = -100) => json_encode(['time' => (string)($now + $offset), 'program' => $program, 'message' => $message]);
$lines = [
  $event('postfix/qmgr', 'ABC123: from=<alex@corp.example>, size=100, nrcpt=2'),
  $event('postfix/smtp', 'ABC123: to=<one@dest.example>, relay=mx, dsn=2.0.0, status=sent (250 OK)'),
  $event('postfix/smtp[123]', 'ABC123: to=<two@dest.example>, relay=mx, dsn=2.0.0, status=sent (250 OK)'),
  $event('postfix/lmtp', 'LOCAL1: to=<alex@corp.example>, relay=dovecot, status=sent (250 OK)'),
  $event('postfix/smtp', 'RETRY1: to=<x@other.example>, relay=none, status=deferred (timeout)'),
  $event('postfix/smtp', 'RETRY1: to=<x@other.example>, relay=none, status=deferred (timeout)', -50),
  $event('postfix/smtp', 'BOUNCE1: to=<x@other.example>, relay=mx, status=bounced (550 no mailbox)'),
  $event('postfix/smtpd', 'NOQUEUE: reject: RCPT from host: 554 rejected'),
  $event('postfix/smtpd', 'SPOOF1: to=<x@other.example>, status=sent (not a delivery client)'),
  $event('postfix/smtp', 'OLD1: to=<x@old.example>, status=sent (250 OK)', -90000),
  $event('postfix/smtp', 'FUTURE1: to=<x@future.example>, status=sent (250 OK)', 60),
  'not json',
];
$stats = OverviewStats::aggregate($lines, $now);
verify($stats['timings']['average_send_seconds'] === null && $stats['timings']['send_samples'] === 0, 'Missing timings are unavailable, not zero');
$timed = OverviewStats::aggregate([
  $event('postfix/smtp', 'TIME1: to=<a@dest.example>, delay=2.5, delays=1/0.2/0.3/1.0, status=sent (250 OK)'),
  $event('postfix/smtp', 'TIME2: to=<b@dest.example>, delay=1.5, delays=0.1/0.2/0.7/0.5, status=sent (250 OK)'),
  $event('postfix/smtp', 'TIME3: to=<c@dest.example>, delay=99, delays=1/1/1/96, status=deferred (timeout)'),
], $now);
verify($timed['timings']['average_send_seconds'] === 2.0 && $timed['timings']['send_samples'] === 2, 'Average send time uses measured successful recipient deliveries');
verify($timed['timings']['average_smtp_response_seconds'] === 0.75, 'SMTP transfer/response phase is measured separately from queue delay');
verify($stats['counts']['sent_messages'] === 1 && $stats['counts']['outbound_deliveries'] === 2, 'Messages are distinct queue IDs; recipients count separately');
verify($stats['counts']['received_messages'] === 1 && $stats['counts']['inbound_deliveries'] === 1, 'Local LMTP deliveries are counted separately');
verify($stats['counts']['deferred_attempts'] === 2, 'Retries remain delivery attempts');
verify($stats['counts']['bounced_deliveries'] === 1 && $stats['counts']['rejected_attempts'] === 1, 'Delivery problems count independently');
verify($stats['top_sending_domains'] === [['domain' => 'corp.example', 'deliveries' => 2]], 'Sending domains correlate with retained queue metadata');
verify($stats['top_recipient_domains'][0]['domain'] === 'dest.example' && $stats['top_recipient_domains'][0]['deliveries'] === 2, 'Top destinations count successful deliveries');
verify($stats['top_local_domains'][0]['domain'] === 'corp.example', 'Local domains use local recipients');
verify(count($stats['hourly']) === 25 && array_sum(array_column($stats['hourly'], 'sent')) === 2, 'Hourly bins cover the partial hours in a rolling day');
verify(OverviewStats::aggregate([], $now)['counts']['sent_messages'] === 0, 'Empty logs return empty observations');
verify($stats['coverage']['oldest_retained'] === $now - 90000, 'Coverage reports actual retention instead of inventing a complete day');

$store = new class($lines) {
  public array $data = [];
  public int $reads = 0;
  public function __construct(public array $lines) {}
  public function lRange($key, $first, $last) { $this->reads++; return $this->lines; }
  public function lLen($key) { return 20050; }
  public function set($key, $value) { $this->data[$key] = $value; }
  public function get($key) { return $this->data[$key] ?? false; }
  public function del($key) { unset($this->data[$key]); }
};
$db = new PDO('sqlite::memory:');
$db->exec("CREATE TABLE domain (active INTEGER); INSERT INTO domain VALUES (1),(0); CREATE TABLE mailbox (username TEXT, kind TEXT, active INTEGER, quota INTEGER); INSERT INTO mailbox VALUES ('alex','',1,1000),('resource','resource',1,9999); CREATE TABLE quota2 (username TEXT, bytes INTEGER, messages INTEGER); INSERT INTO quota2 VALUES ('alex',400,12),('resource',9999,9999)");
fails(fn() => OverviewStats::snapshot($store, $db, 'domainadmin', $now), 'Domain admins cannot read instance-wide metrics');
verify($store->reads === 0, 'Unauthorized requests do not access mail activity');
$snapshot = OverviewStats::snapshot($store, $db, 'admin', $now);
verify($snapshot['inventory']['domains'] === 2 && $snapshot['inventory']['active_domains'] === 1, 'Inventory includes total and active domains');
verify($snapshot['inventory']['mailboxes'] === 1 && $snapshot['inventory']['used_bytes'] === 400 && $snapshot['inventory']['stored_messages'] === 12, 'Resource accounts are excluded from mailbox inventory/storage');
verify($snapshot['coverage']['capped'] && $snapshot['coverage']['scan_limit'] === 20000, 'Bounded metrics expose their scan limit');

$telemetryCache = new class {
  public array $data = [];
  public function get($key) { return $this->data[$key] ?? false; }
  public function setex($key, $ttl, $value) { $this->data[$key] = $value; }
};
$telemetryCalls = [];
$telemetry = static function ($action, ...$arguments) use (&$telemetryCalls, $now) {
  $telemetryCalls[] = $action;
  return match ($action) {
    'host_stats' => ['sampled_at' => $now, 'cpu' => ['usage' => 18.2, 'cores' => 4], 'memory' => ['usage' => 34.4]],
    'post' => json_encode(['total_bytes' => 1000, 'available_bytes' => 600, 'usage_percent' => 40]),
    'containers' => ['nginx-mailcow' => ['State' => ['Running' => true], 'Config' => ['Env' => ['SECRET=private']]]],
  };
};
fails(fn() => OverviewStats::serverSnapshot($telemetryCache, 'domainadmin', $now, $telemetry), 'Domain admins cannot access live host stats');
verify(!$telemetryCalls, 'Live stats authorize before querying host services');
$live = OverviewStats::serverSnapshot($telemetryCache, 'admin', $now, $telemetry);
verify($live['server']['available'] && $live['server']['cpu']['usage'] === 18.2, 'Lightweight live stats use observed host values without a mail-log store or database');
verify($live['services'][0]['running'] && !str_contains(json_encode($live), 'SECRET'), 'Live service status never exposes container environments');
OverviewStats::serverSnapshot($telemetryCache, 'admin', $now + 5, $telemetry);
verify(count(array_filter($telemetryCalls, fn($action) => $action === 'post')) === 1, 'Mail filesystem checks are cached between five-second polls');
$stale = OverviewStats::serverSnapshot($telemetryCache, 'admin', $now + 31, $telemetry);
verify(!$stale['server']['available'] && !isset($stale['server']['cpu']), 'Stale host telemetry cannot be presented as live');
verify(count(array_filter($telemetryCalls, fn($action) => $action === 'post')) === 2, 'Filesystem checks refresh after thirty seconds');
$unavailable = OverviewStats::serverSnapshot($telemetryCache, 'admin', $now + 35, static fn() => throw new RuntimeException('offline'));
verify(!$unavailable['server']['available'] && $unavailable['services'] === null, 'Missing host and service telemetry is explicit');

fails(fn() => Branding::saveName($store, 'domainadmin', false, 'Wrong'), 'Only admins can change business branding');
fails(fn() => Branding::saveName($store, 'admin', true, 'Wrong'), 'Demo branding changes stay disabled');
fails(fn() => Branding::saveName($store, 'admin', false, ''), 'Business names cannot be empty');
Branding::saveName($store, 'admin', false, 'Acme & Co');
verify($store->data['MAIN_NAME'] === 'Acme &amp; Co' && $store->data['TITLE_NAME'] === 'Acme &amp; Co', 'Business names use existing mailcow storage with HTML escaping');
$chunk = static fn(string $type, string $data) => pack('N', strlen($data)).$type.$data.pack('N', crc32($type.$data));
$icon = "\x89PNG\r\n\x1a\n".$chunk('IHDR', pack('NNCCCCC', 32, 32, 8, 6, 0, 0, 0)).$chunk('IDAT', gzcompress(str_repeat("\0".str_repeat("\x1f\x4f\xd8\xff", 32), 32))).$chunk('IEND', '');
$uri = Branding::faviconData($icon);
verify(str_starts_with($uri, 'data:image/png;base64,'), 'Valid PNG favicons are encoded safely');
fails(fn() => Branding::faviconData('<svg><script>alert(1)</script></svg>'), 'SVG/markup is rejected for favicon uploads');
fails(fn() => Branding::faviconData(str_repeat('x', 262145)), 'Favicon file size is bounded');
fails(fn() => Branding::saveFavicon($store, 'admin', false, ['error' => 0, 'tmp_name' => __FILE__]), 'Favicon uploads must come from an HTTP upload');
$store->set('UI_FAVICON', $uri);
verify(Branding::faviconForPage($store) === $uri, 'Saved favicons reach page rendering');
fails(fn() => Branding::saveFavicon($store, 'user', false, [], true), 'Mailbox users cannot reset the instance favicon');
Branding::saveFavicon($store, 'admin', false, [], true);
verify(Branding::faviconForPage($store) === '/favicon.png', 'Reset restores the stock favicon');
$store->set('UI_FAVICON', 'javascript:alert(1)');
verify(Branding::faviconForPage($store) === '/favicon.png', 'Untrusted icon values cannot become executable URLs');

// A realistic but explicitly local preview, generated from the same metric parser.
$demoNow = time(); $demo = [];
for ($i = 0; $i < 220; $i++) {
  $time = $demoNow - ($i * 359 % 85000);
  $id = 'DEMO'.$i;
  $domain = $i % 3 ? 'example.org' : 'studio.co.za';
  $demo[] = ['time' => $time, 'program' => 'postfix/qmgr', 'message' => "$id: from=<team@$domain>, size=100, nrcpt=1"];
  $recipient = ['gmail.com', 'outlook.com', 'example.net'][$i % 3];
  $demo[] = ['time' => $time, 'program' => 'postfix/smtp', 'message' => "$id: to=<person@$recipient>, status=sent (250 OK)"];
  if ($i % 2 === 0) $demo[] = ['time' => $time, 'program' => 'postfix/lmtp', 'message' => "LOCAL$i: to=<team@$domain>, status=sent (250 OK)"];
  if ($i % 35 === 0) $demo[] = ['time' => $time, 'program' => 'postfix/smtp', 'message' => "WAIT$i: to=<person@other.net>, status=deferred (timeout)"];
}
$demoStats = OverviewStats::aggregate($demo, $demoNow);
$demoStats['inventory'] = ['domains' => 2, 'active_domains' => 2, 'mailboxes' => 3, 'active_mailboxes' => 2, 'allocated_bytes' => 16106127360, 'used_bytes' => 3972844748, 'stored_messages' => 6451];
$demoStats['coverage']['capped'] = false; $demoStats['coverage']['scan_limit'] = 20000;
$demoStats['server'] = ['available' => true, 'cpu' => ['cores' => 4, 'usage' => 18.2],
  'memory' => ['total' => 8589934592, 'available' => 5637144576, 'usage' => 34.4],
  'memory_pressure' => ['some' => ['avg10' => 0.12], 'full' => ['avg10' => 0]], 'uptime' => 789300,
  'storage' => ['total_bytes' => 107374182400, 'available_bytes' => 77309411328, 'used_bytes' => 30064771072, 'usage_percent' => 28]];
$output = getenv('PLATES_PREVIEW_DIR') ?: sys_get_temp_dir().'/mailcow-plates-preview';
if (!is_dir($output)) mkdir($output, 0777, true);
file_put_contents($output.'/overview.json', json_encode($demoStats));
echo "Plates: $checks overview/branding backend checks passed.\n";
