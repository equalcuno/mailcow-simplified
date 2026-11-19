<?php
namespace Mailcow\Ui;

/** Instance branding. Uses mailcow's existing Redis persistence and admin session. */
final class Branding {
  private static function authorize(string $role, bool $demo): void {
    if ($role !== 'admin' || $demo) throw new \RuntimeException('Branding changes require an administrator and are unavailable in demo mode.');
  }

  public static function saveName(object $store, string $role, bool $demo, string $name): void {
    self::authorize($role, $demo);
    $name = trim($name);
    if ($name === '' || mb_strlen($name) > 120) throw new \InvalidArgumentException('Enter a business name between 1 and 120 characters.');
    $safe = htmlspecialchars($name, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $store->set('MAIN_NAME', $safe);
    $store->set('TITLE_NAME', $safe);
  }

  public static function faviconData(string $bytes): string {
    if (strlen($bytes) > 262144) throw new \InvalidArgumentException('The favicon must be 256 KiB or smaller.');
    $image = @getimagesizefromstring($bytes);
    if (!$image || !in_array($image[2], [IMAGETYPE_PNG, IMAGETYPE_ICO], true)) throw new \InvalidArgumentException('Choose a PNG or ICO image.');
    if ($image[0] !== $image[1] || $image[0] < 16 || $image[0] > 256) throw new \InvalidArgumentException('Choose a square icon between 16 and 256 pixels.');
    return 'data:'.($image[2] === IMAGETYPE_PNG ? 'image/png' : 'image/vnd.microsoft.icon').';base64,'.base64_encode($bytes);
  }

  public static function saveFavicon(object $store, string $role, bool $demo, array $upload, bool $reset = false): void {
    self::authorize($role, $demo);
    if ($reset) { $store->del('UI_FAVICON'); return; }
    if (($upload['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file($upload['tmp_name'] ?? '')) throw new \InvalidArgumentException('Choose a favicon file to upload.');
    if (($upload['size'] ?? 0) > 262144) throw new \InvalidArgumentException('The favicon must be 256 KiB or smaller.');
    $bytes = file_get_contents($upload['tmp_name']);
    if ($bytes === false) throw new \RuntimeException('Could not read the uploaded icon.');
    $store->set('UI_FAVICON', self::faviconData($bytes));
  }

  public static function faviconForPage(?object $store): string {
    if (!$store) return '/favicon.png';
    try { $value = $store->get('UI_FAVICON'); } catch (\Throwable $e) { return '/favicon.png'; }
    if (is_string($value) && preg_match('#^data:image/(png|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]+$#D', $value)) return $value;
    return '/favicon.png';
  }
}
