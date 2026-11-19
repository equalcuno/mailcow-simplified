<?php
namespace Mailcow\Mailbox;

/** Validate the entire input before invoking the existing, permission-checked mailbox creator. */
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
            if (strlen($row['name']) > 255 || strlen($row['password']) < 16 || strlen($row['password']) > 256
                || !isset($row['quota']) || filter_var($row['quota'], FILTER_VALIDATE_INT, ['options' => ['min_range' => 0]]) === false) {
                throw new \InvalidArgumentException('Check name, quota, and password length on row '.($index + 1).'.');
            }
            $seen[$address] = true;
            [$local, $domain] = explode('@', $address, 2);
            $prepared[] = ['local_part' => $local, 'domain' => $domain, 'name' => $row['name'],
                           'quota' => (int)$row['quota'], 'password' => $row['password'],
                           'password2' => $row['password'], 'active' => 1, 'authsource' => 'mailcow', 'sogo_access' => 1];
        }
        return $prepared;
    }
}
