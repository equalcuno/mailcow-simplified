<?php
if (getenv('WEBMAIL_CLIENT') === 'sogo') { require __DIR__.'/legacy-sogo-auth.php'; exit; }
// Compatibility for old login-as bookmarks; all authorization is in the new bridge.
$target = isset($_GET['login']) && is_string($_GET['login']) ? $_GET['login'] : null;
header('Location: /webmail.php'.($target !== null ? '?login='.rawurlencode($target) : ''), true, 302);
