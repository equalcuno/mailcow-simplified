<?php
/** Presentation preferences only. Authentication and authorization stay with mailcow. */
function mailcow_plates_presentation(string $default = 'plates', string $componentDefault = 'redesigned'): array {
  global $redis;
  $choices = ['plates', 'stock'];
  $requested = $_GET['ui'] ?? null;
  if (is_string($requested) && in_array($requested, $choices, true)) {
    // An HttpOnly preference cookie, never a credential or an authorization decision.
    setcookie('mailcow_presentation', $requested, [
      'expires' => time() + 31536000,
      'path' => '/',
      'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
      'httponly' => true,
      'samesite' => 'Lax',
    ]);
  }
  $selected = is_string($requested) && in_array($requested, $choices, true)
    ? $requested : ($_COOKIE['mailcow_presentation'] ?? $default);
  if (!is_string($selected) || !in_array($selected, $choices, true)) {
    $selected = in_array($default, $choices, true) ? $default : 'stock';
  }
  $labels = json_decode(file_get_contents(__DIR__.'/lang/en.json'), true);
  $componentChoices = ['redesigned', 'original'];
  $components = $_GET['components'] ?? ($_COOKIE['mailcow_components'] ?? $componentDefault);
  if (!is_string($components) || !in_array($components, $componentChoices, true)) $components = 'redesigned';
  if (isset($_GET['components']) && is_string($_GET['components']) && in_array($_GET['components'], $componentChoices, true)) {
    setcookie('mailcow_components', $components, [
      'expires' => time() + 31536000, 'path' => '/',
      'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
      'httponly' => true, 'samesite' => 'Lax',
    ]);
  }
  $locale = substr($_SESSION['mailcow_locale'] ?? 'en', 0, 2);
  // Only known, shipped translations can ever become a filesystem path.
  if (in_array($locale, ['de'], true)) {
    $labels = array_replace($labels, json_decode(file_get_contents(__DIR__.'/lang/'.$locale.'.json'), true));
  }
  $hashes = '';
  foreach (['plates.css', 'plates.js', 'components.css', 'components.js', 'preferences.css', 'preferences.js'] as $asset) $hashes .= hash_file('sha256', __DIR__.'/assets/'.$asset);
  $version = substr(hash('sha256', $hashes), 0, 12);
  return ['enabled' => $selected === 'plates', 'components' => $components, 'text' => $labels, 'version' => $version, 'acl' => $_SESSION['acl'] ?? [], 'favicon' => \Mailcow\Ui\Branding::faviconForPage($redis ?? null)];
}
