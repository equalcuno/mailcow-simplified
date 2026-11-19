<?php
try {
    require '/var/www/html/program/include/iniset.php';
    $app = rcmail::get_instance();
    $app->db->query('SELECT 1 FROM '.$app->db->table_name('users').' LIMIT 0');
    if ($app->db->is_error()) throw new RuntimeException('Roundcube database is unavailable.');
    header('Content-Type: text/plain');
    echo "OK\n";
} catch (Throwable $e) {
    http_response_code(503);
    error_log('Roundcube readiness check failed.');
    exit(1);
}
