<?php
/** DNS observations are fixtures: no external network or production accounts. */
require dirname(__DIR__, 2).'/data/web/inc/lib/mailcow/Ui/DomainSetup.php';
use Mailcow\Ui\DomainSetup;
$checks = 0;
function verify(bool $condition, string $message): void {
    global $checks;
    if (!$condition) throw new RuntimeException($message);
    $checks++;
}
$mx = DomainSetup::record('example.org', 'MX', 'mail.example.org', [
    ['target' => 'MAIL.EXAMPLE.ORG.', 'pri' => 10], ['target' => 'backup.example.org', 'pri' => 20],
], true);
verify($mx['status'] === 'complete', 'Primary MX comparison ignores case and trailing dots');
$backup = DomainSetup::record('example.org', 'MX', 'mail.example.org', [
    ['target' => 'other.example.org', 'pri' => 5], ['target' => 'mail.example.org', 'pri' => 10],
], true);
verify($backup['status'] === 'mismatch', 'A backup MX alone does not complete setup');
$ipv6 = DomainSetup::record('mail.example.org', 'AAAA', '2001:db8::1', [['ipv6' => '2001:db8:0:0:0:0:0:1']], true);
verify($ipv6['status'] === 'complete', 'Equivalent IPv6 representations match');
verify(DomainSetup::allowsAddress('192.0.2.10', ['192.0.2.0/24']) && !DomainSetup::allowsAddress('192.0.3.10', ['192.0.2.0/24']), 'SPF IPv4 CIDR ranges are checked against the actual server address');
verify(DomainSetup::allowsAddress('2001:db8::1', ['2001:db8::/32']) && !DomainSetup::allowsAddress('2001:db9::1', ['2001:db8::/32']), 'SPF IPv6 CIDR ranges are checked against the actual server address');
$spf = DomainSetup::record('example.org', 'TXT', 'v=spf1 mx -all', [['txt' => 'unrelated'], ['txt' => 'v=spf1 mx ~all']], true, 'spf', true);
verify($spf['status'] === 'complete', 'Existing passing SPF policies need not match the suggested policy');
$duplicates = DomainSetup::record('example.org', 'TXT', 'v=spf1 mx -all', [['txt' => 'v=spf1 mx -all'], ['txt' => 'v=spf1 a -all']], true, 'spf', true);
verify($duplicates['status'] === 'mismatch', 'Duplicate SPF policies cannot pass');
$dmarc = DomainSetup::record('_dmarc.example.org', 'TXT', 'v=DMARC1; p=none', [['txt' => 'v=DMARC1; p=reject; rua=mailto:reports@example.org']], true, 'dmarc');
verify($dmarc['status'] === 'complete', 'An existing stricter DMARC policy passes');
$invalidDmarc = DomainSetup::record('_dmarc.example.org', 'TXT', 'v=DMARC1; p=none', [['txt' => 'v=DMARC1; p=invalid']], true, 'dmarc');
verify($invalidDmarc['status'] === 'mismatch', 'An invalid DMARC policy does not pass');
$dkim = DomainSetup::record('dkim._domainkey.example.org', 'TXT', 'v=DKIM1; k=rsa; p=PUBLICKEY', [['txt' => 'v=DKIM1; p=OTHERKEY']], true, 'dkim');
verify($dkim['status'] === 'mismatch', 'An old DKIM public key does not pass');
$missing = DomainSetup::record('dkim._domainkey.example.org', 'TXT', 'v=DKIM1; p=PUBLICKEY', [], true, 'dkim');
verify($missing['status'] === 'missing', 'Missing required records are explicit');
$unknown = DomainSetup::record('example.org', 'MX', 'mail.example.org', false, true);
verify($unknown['status'] === 'unconfirmed', 'A resolver error stays unconfirmed');
$optional = DomainSetup::record('autoconfig.example.org', 'CNAME', 'mail.example.org', [], false);
$ready = DomainSetup::summary('example.org', [$mx, $spf, $dmarc, $optional], true, 123);
verify($ready['ready'] && $ready['complete'] === 3 && $ready['checked_at'] === 123, 'Recommended records do not block completed required checks');
verify(!DomainSetup::summary('example.org', [$mx, $missing], true, 123)['ready'], 'Enabling a domain cannot bypass incomplete DNS setup');
verify(!DomainSetup::summary('example.org', [$unknown], true, 123)['ready'], 'A failed lookup cannot mark a domain ready');
verify(!DomainSetup::summary('example.org', [], true, 123)['ready'], 'An empty diagnostic response cannot mark a domain ready');
verify(!DomainSetup::summary('example.org', [$mx], false, 123)['enabled'], 'Disabled domain state is independent of DNS completion');
echo "Domain setup: $checks checks passed.\n";
