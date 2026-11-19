<?php
// Loaded by the official Roundcube image after its generated Docker configuration.
$key = getenv('ROUNDCUBE_DES_KEY');
if (!is_string($key) || strlen($key) !== 24) {
    throw new RuntimeException('Set a persistent 24-character ROUNDCUBE_DES_KEY in mailcow.conf.');
}
$config['des_key'] = $key;
// Store metadata in the existing, backed-up mailcow database without table collisions.
$config['db_prefix'] = 'roundcube_';
$config['product_name'] = 'Webmail';
$config['request_path'] = '/webmail/';
$config['session_name'] = 'roundcube_sessid';
$config['session_path'] = '/webmail/';
$config['session_samesite'] = 'Lax';
$config['use_https'] = ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
$config['enable_installer'] = false;
$config['enable_spellcheck'] = false;
$config['login_autocomplete'] = 0;
$config['log_logins'] = true;
// Dovecot accepts the SSO password and plaintext auth only from the .248 IPv4
// address; a service name may resolve to IPv6 and be rejected.
$address = static function ($variable, $fallback) {
    $value = getenv($variable);
    return is_string($value) && filter_var($value, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) ? $value : $fallback;
};
$dovecot = $address('MAILCOW_DOVECOT_ADDR', 'dovecot-mailcow');
$postfix = $address('MAILCOW_POSTFIX_ADDR', 'postfix-mailcow');
$config['imap_host'] = $dovecot.':143';
$config['smtp_host'] = $postfix.':588';
$config['smtp_user'] = '%u';
$config['smtp_pass'] = '%p';
$config['imap_auth_type'] = 'PLAIN';
$config['smtp_auth_type'] = 'PLAIN';
// Only the dedicated webmail container uses Dovecot's existing trusted .248 address.
// Do not disable certificate verification or relax authentication for the whole subnet.
$config['managesieve_host'] = $dovecot.':4190';
$config['managesieve_auth_type'] = 'PLAIN';
$config['managesieve_script_name'] = 'roundcube';
$config['managesieve_vacation'] = 1;
$config['managesieve_forward'] = 1;
$config['drafts_mbox'] = 'Drafts';
$config['sent_mbox'] = 'Sent';
$config['junk_mbox'] = 'Junk';
$config['trash_mbox'] = 'Trash';
$config['create_default_folders'] = true;
$config['identities_level'] = 3;
$config['logout_url'] = '/webmail.php?logout=1';
$config['plugins'] = ['archive', 'zipdownload', 'managesieve', 'acl', 'markasjunk', 'mailcow_sso'];
// Private instance branding/preferences stay outside Git and survive fork upgrades.
$local = '/var/roundcube/config/custom/config.inc.php';
if (is_file($local)) require $local;
