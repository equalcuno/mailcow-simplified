<?php
namespace Mailcow\Mailbox;

/** Preflight identities and retain value errors per row so valid mailboxes can proceed. */
final class BatchCreator {
    public static function prepare(array $rows): array {
        if (count($rows) < 1 || count($rows) > 50) throw new \InvalidArgumentException('Create between 1 and 50 mailboxes per batch.');
        $prepared = []; $seen = [];
        foreach ($rows as $index => $row) {
            if (!is_array($row)) throw new \InvalidArgumentException('Invalid mailbox row.');
            foreach (['local_part', 'domain', 'name', 'password'] as $key) {
                if (!isset($row[$key]) || !is_string($row[$key])) throw new \InvalidArgumentException('Each row needs an address, name and password.');
            }
            $address = strtolower(trim($row['local_part']).'@'.trim($row['domain']));
            if (!filter_var($address, FILTER_VALIDATE_EMAIL) || isset($seen[$address])) {
                throw new \InvalidArgumentException('Invalid or duplicate address on row '.($index + 1).'.');
            }
            $error = null;
            if (strlen($row['name']) > 255) $error = 'Display name is too long (maximum 255).';
            elseif (strlen($row['password']) < 16) $error = 'Password is too short (minimum 16).';
            elseif (strlen($row['password']) > 256) $error = 'Password is too long (maximum 256).';
            elseif (!isset($row['quota']) || filter_var($row['quota'], FILTER_VALIDATE_INT, ['options' => ['min_range' => 0]]) === false) {
                $error = 'Quota must be a whole number of MiB, zero or greater.';
            }
            $seen[$address] = true;
            [$local, $domain] = explode('@', $address, 2);
            $prepared[] = ['local_part' => $local, 'domain' => $domain, 'name' => $row['name'],
                           'quota' => $error === null ? (int)$row['quota'] : 0, 'password' => $row['password'],
                           'password2' => $row['password'], 'active' => 1, 'authsource' => 'mailcow', 'sogo_access' => 1];
            if ($error !== null) $prepared[count($prepared) - 1]['validation_error'] = $error;
        }
        return $prepared;
    }
}
