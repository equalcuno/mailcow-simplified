<?php
/**
 * SSO from nginx's session-checked, overwritten Authorization header.
 * The container has no published port. Never accept credentials from query parameters.
 * Copyright mailcow-simplified contributors. SPDX-License-Identifier: GPL-3.0-or-later
 */
class mailcow_sso extends rcube_plugin {
    public function init() {
        $this->add_hook('startup', [$this, 'startup']);
        $this->add_hook('authenticate', [$this, 'authenticate']);
    }

    public function startup($args) {
        $user = $_SERVER['PHP_AUTH_USER'] ?? '';
        $password = $_SERVER['PHP_AUTH_PW'] ?? '';
        if (!filter_var($user, FILTER_VALIDATE_EMAIL) || $password === '') {
            http_response_code(401);
            exit('A mailcow session is required.');
        }
        $app = rcmail::get_instance();
        // A browser can switch mailboxes through admin login-as. Never reuse another inbox.
        if (!empty($_SESSION['user_id']) && ($_SESSION['username'] ?? '') !== $user) {
            $app->kill_session();
        }
        if (empty($_SESSION['user_id'])) {
            $args['action'] = 'login';
        } else {
            // Dovecot rotates the internal SSO password at restart.
            $_SESSION['password'] = $app->encrypt($password);
        }
        // Keep the shared internal credential out of Roundcube's persisted sessions.
        $app->add_shutdown_function(static function () use ($app) {
            $app->session->remove('password');
        });
        return $args;
    }

    public function authenticate($args) {
        if (empty($_SERVER['PHP_AUTH_USER']) || empty($_SERVER['PHP_AUTH_PW'])) {
            $args['valid'] = false;
            return $args;
        }
        $args['user'] = $_SERVER['PHP_AUTH_USER'];
        $args['pass'] = $_SERVER['PHP_AUTH_PW'];
        $args['host'] = 'dovecot-mailcow';
        $args['cookiecheck'] = false;
        $args['valid'] = true;
        return $args;
    }
}
