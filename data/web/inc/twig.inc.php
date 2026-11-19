<?php

use Twig\Environment;
use Twig\Loader\FilesystemLoader;
use Twig\TwigFilter;
use Twig\TwigFunction;

$loader = new FilesystemLoader($_SERVER['DOCUMENT_ROOT'].'/templates');
// Keep stock templates addressable so the presentation can inherit, rather than copy, them.
$loader->addPath($_SERVER['DOCUMENT_ROOT'].'/templates', 'upstream');
$plates = ['enabled' => false];
if (is_file($_SERVER['DOCUMENT_ROOT'].'/ui/plates/presentation.php')) {
  require_once $_SERVER['DOCUMENT_ROOT'].'/ui/plates/presentation.php';
  // Override the default in vars.local.inc.php; browser preferences are cosmetic only.
  $plates = mailcow_plates_presentation($UI_PRESENTATION ?? 'plates', $UI_COMPONENTS ?? 'redesigned');
  $loader->addPath($_SERVER['DOCUMENT_ROOT'].'/ui/plates/templates', 'plates');
}
if ($plates['enabled']) {
  $loader->prependPath($_SERVER['DOCUMENT_ROOT'].'/ui/plates/templates');
  if ($plates['components'] === 'redesigned') {
    $loader->prependPath($_SERVER['DOCUMENT_ROOT'].'/ui/plates/redesigned');
  }
}
$twig = new Environment($loader, [
  'debug' => $DEV_MODE,
  // Presentation switches and deployments must not reuse stale compiled templates.
  'auto_reload' => true,
  'cache' => $_SERVER['DOCUMENT_ROOT'].'/templates/cache',
]);
$twig->addGlobal('plates', $plates);

// functions
$twig->addFunction(new TwigFunction('query_string', function (array $params = []) {
  $allowed = ['lang', 'mobileconfig'];
  $filtered = array_intersect_key($_GET, array_flip($allowed));
  return http_build_query(array_merge($filtered, $params));
}));

$twig->addFunction(new TwigFunction('is_uri', function (string $uri, string $where = null) {
  if (is_null($where)) $where = $_SERVER['REQUEST_URI'];
  return preg_match('/'.$uri.'/i', $where);
}));

// filters
$twig->addFilter(new TwigFilter('rot13', 'str_rot13'));
$twig->addFilter(new TwigFilter('base64_encode', 'base64_encode'));
$twig->addFilter(new TwigFilter('formatBytes', 'formatBytes'));
$twig->addFilter(new TwigFilter('brand_text', static function ($value) {
  return html_entity_decode(strip_tags((string)$value), ENT_QUOTES | ENT_HTML5, 'UTF-8');
}));
