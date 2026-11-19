<?php
namespace Mailcow\Ui;

/** Session policy shared by the public mailbox selector and internal nginx verifier. */
final class WebmailAccess {
    public static function details(\PDO $pdo, string $target): array {
        $query = $pdo->prepare("SELECT m.username, m.active, m.attributes, d.active AS domain_active
            FROM mailbox m INNER JOIN domain d ON d.domain = m.domain
            WHERE m.username = :username AND (m.kind = '' OR m.kind IS NULL)");
        $query->execute([':username' => $target]);
        $mailbox = $query->fetch(\PDO::FETCH_ASSOC);
        if (!is_array($mailbox)) return [];
        $mailbox['attributes'] = json_decode($mailbox['attributes'], true) ?: [];
        return $mailbox;
    }

    public static function actor(array $session): array {
        return $session['dual-login'] ?? [
            'username' => $session['mailcow_cc_username'] ?? '',
            'role' => $session['mailcow_cc_role'] ?? '',
        ];
    }

    public static function target(array $session): string {
        if (($session['mailcow_cc_role'] ?? '') === 'user') {
            return (string)($session['mailcow_cc_username'] ?? '');
        }
        return (string)($session['webmail_login_as'] ?? '');
    }

    public static function allowed(array $session, array $mailbox, string $target,
                                   bool $inScope, bool $adminLogin): bool {
        if (!filter_var($target, FILTER_VALIDATE_EMAIL) || !$inScope
            || !empty($session['mailcow_cc_api']) || !empty($session['pending_tfa_setup'])
            || !empty($session['pending_pw_update']) || empty($mailbox['active'])
            || empty($mailbox['domain_active']) || ($mailbox['username'] ?? '') !== $target
            || !empty($mailbox['attributes']['force_pw_update'])
            || empty($mailbox['attributes']['sogo_access'])
            || !in_array($session['mailcow_cc_role'] ?? '', ['user', 'admin', 'domainadmin'], true)) {
            return false;
        }
        $actor = self::actor($session);
        if ($actor['role'] === 'user') {
            return ($session['mailcow_cc_role'] ?? '') === 'user' && $actor['username'] === $target;
        }
        return in_array($actor['role'], ['admin', 'domainadmin'], true) && $adminLogin
            && (int)($session['acl']['login_as'] ?? 0) === 1;
    }
}
