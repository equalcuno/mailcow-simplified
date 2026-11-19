<?php
namespace Mailcow\Ui;

/** Aggregate retained Postfix events without confusing recipient deliveries with messages. */
final class OverviewStats {
  public static function aggregate(array $lines, int $now): array {
    $since = $now - 86400;
    $start = intdiv($since, 3600) * 3600;
    $hours = [];
    for ($i = 0; $i < 25; $i++) $hours[$start + $i * 3600] = ['time' => $start + $i * 3600, 'sent' => 0, 'received' => 0];
    $counts = ['sent_messages' => 0, 'received_messages' => 0, 'outbound_deliveries' => 0, 'inbound_deliveries' => 0, 'deferred_attempts' => 0, 'bounced_deliveries' => 0, 'rejected_attempts' => 0];
    $sent = $received = $destinations = $senders = $local = $queueSenders = [];
    $events = []; $oldest = null; $newest = null;
    $sendTimes = []; $deliveryTimes = [];
    foreach ($lines as $line) {
      $event = is_array($line) ? $line : json_decode(trim((string)$line), true);
      if (!is_array($event) || !is_numeric($event['time'] ?? null)) continue;
      $time = (int)$event['time'];
      if ($time > $now) continue;
      $oldest = $oldest === null ? $time : min($oldest, $time);
      $newest = $newest === null ? $time : max($newest, $time);
      $message = (string)($event['message'] ?? '');
      if (preg_match('/^([A-Za-z0-9]+): from=<[^@<>]*@([^<>]+)>/', $message, $match)) $queueSenders[$match[1]] = strtolower($match[2]);
      if ($time >= $since) $events[] = [$time, (string)($event['program'] ?? ''), $message];
    }
    foreach ($events as [$time, $program, $message]) {
      if (strpos($message, 'NOQUEUE: reject:') !== false) $counts['rejected_attempts']++;
      if (!preg_match('/^([A-Za-z0-9]+): to=<([^<>]*)>.*\bstatus=(sent|deferred|bounced)\b/', $message, $match)) continue;
      $smtp = preg_match('#(?:^|/)smtp(?:\[|$)#', $program);
      $lmtp = preg_match('#(?:^|/)lmtp(?:\[|$)#', $program);
      if (!$smtp && !$lmtp) continue;
      $status = $match[3];
      if ($status === 'deferred') { $counts['deferred_attempts']++; continue; }
      if ($status === 'bounced') { $counts['bounced_deliveries']++; continue; }
      $domain = strrpos($match[2], '@') !== false ? strtolower(substr($match[2], strrpos($match[2], '@') + 1)) : null;
      $hour = intdiv($time, 3600) * 3600;
      if ($smtp) {
        $counts['outbound_deliveries']++; $sent[$match[1]] = true; $hours[$hour]['sent']++;
        // Postfix delay is queue-to-delivery time; delays' fourth phase is SMTP transfer/response.
        if (preg_match('/\bdelay=([0-9]+(?:\.[0-9]+)?)(?:,|\s)/', $message, $timing)) $sendTimes[] = (float)$timing[1];
        if (preg_match('/\bdelays=[0-9.]+\/[0-9.]+\/[0-9.]+\/([0-9]+(?:\.[0-9]+)?)(?:,|\s)/', $message, $timing)) $deliveryTimes[] = (float)$timing[1];
        if ($domain) $destinations[$domain] = ($destinations[$domain] ?? 0) + 1;
        if (isset($queueSenders[$match[1]])) { $sender = $queueSenders[$match[1]]; $senders[$sender] = ($senders[$sender] ?? 0) + 1; }
      } else {
        $counts['inbound_deliveries']++; $received[$match[1]] = true; $hours[$hour]['received']++;
        if ($domain) $local[$domain] = ($local[$domain] ?? 0) + 1;
      }
    }
    $counts['sent_messages'] = count($sent); $counts['received_messages'] = count($received);
    $rank = static function (array $values): array {
      arsort($values); $rows = [];
      foreach (array_slice($values, 0, 5, true) as $domain => $count) $rows[] = ['domain' => $domain, 'deliveries' => $count];
      return $rows;
    };
    return [
      'generated_at' => $now, 'counts' => $counts, 'hourly' => array_values($hours),
      'timings' => [
        'average_send_seconds' => $sendTimes ? array_sum($sendTimes) / count($sendTimes) : null,
        'send_samples' => count($sendTimes),
        'average_smtp_response_seconds' => $deliveryTimes ? array_sum($deliveryTimes) / count($deliveryTimes) : null,
        'smtp_response_samples' => count($deliveryTimes),
        'definition' => 'Successful outbound recipient deliveries only. Send time includes queueing; SMTP response time is the combined transfer/response phase, not pure network RTT.',
      ],
      'top_recipient_domains' => $rank($destinations), 'top_sending_domains' => $rank($senders), 'top_local_domains' => $rank($local),
      'coverage' => ['requested_since' => $since, 'oldest_retained' => $oldest, 'newest_retained' => $newest, 'scanned_lines' => count($lines), 'source' => 'retained_postfix_log', 'message_definition' => 'Distinct queue IDs with at least one successful SMTP or LMTP recipient delivery. Internal LMTP deliveries can include local-to-local mail.'],
    ];
  }

  public static function snapshot(object $redis, \PDO $pdo, string $role, int $now): array {
    if ($role !== 'admin') throw new \RuntimeException('Administrator access required');
    $lines = $redis->lRange('POSTFIX_MAILLOG', 0, 19999);
    if (!is_array($lines)) throw new \RuntimeException('Mail activity logs are unavailable');
    $snapshot = self::aggregate($lines, $now);
    $snapshot['coverage']['scan_limit'] = 20000;
    $snapshot['coverage']['capped'] = (int)$redis->lLen('POSTFIX_MAILLOG') > 20000;
    $domains = $pdo->query('SELECT COUNT(*) AS total, COALESCE(SUM(active),0) AS active FROM domain')->fetch(\PDO::FETCH_ASSOC);
    $mailboxes = $pdo->query("SELECT COUNT(*) AS total, COALESCE(SUM(active),0) AS active, COALESCE(SUM(quota),0) AS allocated FROM mailbox WHERE kind = '' OR kind IS NULL")->fetch(\PDO::FETCH_ASSOC);
    $storage = $pdo->query("SELECT COALESCE(SUM(q.bytes),0) AS used, COALESCE(SUM(q.messages),0) AS messages FROM quota2 AS q INNER JOIN mailbox AS m ON m.username = q.username WHERE m.kind = '' OR m.kind IS NULL")->fetch(\PDO::FETCH_ASSOC);
    $snapshot['inventory'] = ['domains' => (int)$domains['total'], 'active_domains' => (int)$domains['active'], 'mailboxes' => (int)$mailboxes['total'], 'active_mailboxes' => (int)$mailboxes['active'], 'allocated_bytes' => (int)$mailboxes['allocated'], 'used_bytes' => (int)$storage['used'], 'stored_messages' => (int)$storage['messages']];
    $snapshot['server'] = ['available' => false];
    try {
      if (function_exists('docker')) {
        $host = \docker('host_stats');
        if (is_array($host) && isset($host['cpu'], $host['memory'])) {
          $snapshot['server'] = $host + ['available' => true, 'source' => 'docker_host_kernel'];
        }
        $disk = json_decode((string)\docker('post', 'dovecot-mailcow', 'exec', ['cmd' => 'system', 'task' => 'storage']), true);
        if (is_array($disk) && isset($disk['total_bytes'], $disk['available_bytes'])) $snapshot['server']['storage'] = $disk;
      }
    } catch (\Throwable $e) {
      // Mail metrics remain useful when host telemetry is temporarily unavailable.
    }
    return $snapshot;
  }
}
