<?php
namespace Mailcow\Ui;

/** Readiness is derived from DNS observations, never from the domain's enabled flag alone. */
final class DomainSetup {
    public static function record(string $name, string $type, string $expected, array|false $answers,
                                  bool $required, string $kind = 'record', ?bool $spfAllowed = null): array {
        $values = [];
        foreach ($answers ?: [] as $answer) {
            $value = match ($type) {
                'A' => $answer['ip'] ?? '',
                'AAAA' => $answer['ipv6'] ?? '',
                'TXT' => $answer['txt'] ?? implode('', $answer['entries'] ?? []),
                'SRV' => ($answer['target'] ?? '.').' '.($answer['port'] ?? 0),
                default => $answer['target'] ?? '',
            };
            if ($kind === 'spf' && !preg_match('/^v=spf1(?:\s|$)/i', $value)) continue;
            if ($kind === 'dmarc' && !preg_match('/^v=DMARC1\s*;/i', $value)) continue;
            $values[] = $value;
        }
        $passed = false;
        if ($kind === 'spf') $passed = count($values) === 1 && $spfAllowed === true;
        elseif ($kind === 'dmarc') {
            $tags = self::tags($values[0] ?? '');
            $passed = count($values) === 1 && in_array(strtolower($tags['p'] ?? ''), ['none', 'quarantine', 'reject'], true);
        } elseif ($kind === 'dkim') {
            $key = self::tags($expected)['p'] ?? '';
            $tags = self::tags($values[0] ?? '');
            $passed = count($values) === 1 && $key !== '' && strcasecmp($tags['v'] ?? 'DKIM1', 'DKIM1') === 0
                && strcasecmp($tags['k'] ?? 'rsa', 'rsa') === 0
                && preg_replace('/\s+/', '', $tags['p'] ?? '') === preg_replace('/\s+/', '', $key);
        } else {
            foreach ($values as $value) {
                if (in_array($type, ['A', 'AAAA'], true)) {
                    $passed = $passed || (filter_var($expected, FILTER_VALIDATE_IP) && @inet_pton($expected) === @inet_pton($value));
                } else {
                    $passed = $passed || self::hostnameValue($value) === self::hostnameValue($expected);
                }
            }
            // This server must be a primary MX, rather than only a backup for another provider.
            if ($passed && $type === 'MX') {
                $priority = min(array_column($answers, 'pri'));
                $passed = false;
                foreach ($answers as $answer) {
                    if (($answer['pri'] ?? null) === $priority && strtolower(rtrim($answer['target'] ?? '', '.')) === strtolower(rtrim($expected, '.'))) $passed = true;
                }
            }
        }
        $status = $passed ? 'complete' : ($answers === false || $expected === '' ? 'unconfirmed' : ($values ? 'mismatch' : 'missing'));
        return compact('name', 'type', 'expected', 'required', 'status') + ['current' => $values];
    }

    public static function allowsAddress(string $address, array $networks): bool {
        $binary = @inet_pton($address);
        if ($binary === false) return false;
        foreach ($networks as $network) {
            $parts = explode('/', $network, 2);
            $base = @inet_pton($parts[0]);
            if ($base === false || strlen($base) !== strlen($binary)) continue;
            $bits = isset($parts[1]) ? filter_var($parts[1], FILTER_VALIDATE_INT) : strlen($base) * 8;
            if ($bits === false || $bits < 0 || $bits > strlen($base) * 8) continue;
            $bytes = intdiv($bits, 8); $remainder = $bits % 8;
            if (substr($binary, 0, $bytes) !== substr($base, 0, $bytes)) continue;
            if ($remainder === 0 || ((ord($binary[$bytes]) ^ ord($base[$bytes])) & (255 << (8 - $remainder))) === 0) return true;
        }
        return false;
    }

    private static function hostnameValue(string $value): string {
        return preg_replace('/\.(?=\s|$)/', '', strtolower($value));
    }

    public static function summary(string $domain, array $records, bool $enabled, int $checkedAt): array {
        $required = array_values(array_filter($records, static fn($record) => $record['required']));
        $complete = count(array_filter($required, static fn($record) => $record['status'] === 'complete'));
        $ready = count($required) > 0 && $complete === count($required);
        return ['domain' => $domain, 'enabled' => $enabled, 'ready' => $ready,
                'required' => count($required), 'complete' => $complete, 'checked_at' => $checkedAt, 'records' => $records];
    }

    private static function tags(string $value): array {
        $tags = [];
        foreach (explode(';', $value) as $part) {
            $pair = explode('=', trim($part), 2);
            if (count($pair) === 2) {
                $name = strtolower(trim($pair[0]));
                if (array_key_exists($name, $tags)) return [];
                $tags[$name] = trim($pair[1]);
            }
        }
        return $tags;
    }
}
