<?php
namespace Mailcow\Mailbox;

/** Read-only search scope shared by the API and its regression checks. */
final class MailboxSearchScope {
  public static function forCaller(string $role, string $username, $domain = null): array {
    if (!in_array($role, ['admin', 'domainadmin'], true)) {
      throw new \InvalidArgumentException('Mailbox search requires a management role');
    }
    $scope = ['condition' => "(`m`.`kind` = '' OR `m`.`kind` = NULL)", 'bindings' => []];
    if (is_string($domain) && $domain !== '') {
      $scope['condition'] .= ' AND `m`.`domain` = :filter_domain';
      $scope['bindings']['filter_domain'] = $domain;
    }
    if ($role === 'domainadmin') {
      $scope['condition'] .= ' AND `da`.`active` = 1 AND `da`.`username` = :username';
      $scope['bindings']['username'] = $username;
    }
    return $scope;
  }
}
