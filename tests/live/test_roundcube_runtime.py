#!/usr/bin/env python3
"""Opt-in isolated Docker check: real Roundcube/MariaDB/Dovecot/nginx, fixture SMTP.

No production config, containers, ports, credentials or volumes are used.
"""
import base64
import http.cookiejar
import json
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PASSWORD = 'f' * 32
PREFIX = 'roundcube-check-' + uuid.uuid4().hex[:8]
CONTAINERS = []


def docker(*args, check=True):
    result = subprocess.run(['docker', *args], text=True, capture_output=True, timeout=180)
    if check and result.returncode:
        raise RuntimeError(f'Docker {args[0]}: {result.stderr}')
    return result.stdout.strip()


def create(name, *args):
    CONTAINERS.append(name)
    return docker('create', '--name', name, '--label', f'com.mailcow.roundcube-test={PREFIX}',
                  '--network', PREFIX, *args)


def wait(check, label):
    for _ in range(90):
        try:
            if check():
                return
        except (Exception, urllib.error.URLError):
            pass
        time.sleep(1)
    raise RuntimeError('Timed out waiting for ' + label)


def cookie(jar, user):
    jar.set_cookie(http.cookiejar.Cookie(0, 'fixture_user', user, None, False,
                   '127.0.0.1', False, False, '/', True, False, None, True, None, None, {}))


def main():
    docker('network', 'create', PREFIX)
    with tempfile.TemporaryDirectory(prefix='roundcube-runtime-') as directory:
        fixture = Path(directory)
        (fixture / 'mail').mkdir()
        for user in ('alex', 'other'):
            mail = fixture / 'mail' / user
            for folder in ('new', 'cur', 'tmp'):
                (mail / folder).mkdir(parents=True)
            (mail / 'new' / 'fixture.eml').write_text(
                f'From: sender@example.org\r\nTo: {user}@example.org\r\n'
                f'Subject: {user.upper()}_ONLY_MESSAGE\r\nMessage-ID: <{user}@fixture>\r\n'
                'Date: Wed, 18 Nov 2026 12:00:00 +0000\r\n\r\nFixture body.\r\n')
        (fixture / 'dovecot.conf').write_text(f'''
protocols = imap
ssl = no
disable_plaintext_auth = no
auth_mechanisms = plain login
mail_location = maildir:/fixture/mail/%n
first_valid_uid = 5000
log_path = /dev/stderr
info_log_path = /dev/stdout
base_dir = /tmp/dovecot-fixture
passdb {{
 driver = static
 args = password={{plain}}{PASSWORD}
}}
userdb {{
 driver = static
 args = uid=5000 gid=5000 home=/fixture/mail/%n allow_all_users=yes
}}
service imap-login {{
 inet_listener imap {{
  port = 143
 }}
}}
''')
        (fixture / 'smtp.py').write_text('''import base64, socketserver
from pathlib import Path
class SMTP(socketserver.StreamRequestHandler):
 def handle(self):
  def reply(s): self.wfile.write((s+'\\r\\n').encode()); self.wfile.flush()
  reply('220 fixture ESMTP')
  while True:
   line=self.rfile.readline().decode().strip()
   if not line: return
   command=line.split()[0].upper()
   if command in ['EHLO','HELO']: reply('250-fixture\\r\\n250-AUTH PLAIN\\r\\n250 SIZE 104857600')
   elif command=='AUTH':
    if len(line.split()) < 3:
     reply('334 '); payload=self.rfile.readline().decode().strip()
    else: payload=line.split()[-1]
    try: valid=base64.b64decode(payload).split(b'\\0')[-1]==b'ffffffffffffffffffffffffffffffff'
    except Exception: valid=False
    reply('235 Authenticated' if valid else '535 Invalid credentials')
   elif command in ['MAIL','RCPT','RSET','NOOP']: reply('250 OK')
   elif command=='DATA':
    reply('354 End with dot'); message=[]
    while True:
     data=self.rfile.readline()
     if data==b'.\\r\\n' or not data: break
     message.append(data)
    Path('/fixture/sent.eml').write_bytes(b''.join(message)); reply('250 Queued')
   elif command=='QUIT': reply('221 Bye'); return
   else: reply('502 Unsupported')
socketserver.ThreadingTCPServer.allow_reuse_address=True
socketserver.ThreadingTCPServer(('0.0.0.0',588), SMTP).serve_forever()
''')
        db, imap, rc, proxy = (PREFIX + '-' + part for part in ('db', 'imap', 'rc', 'proxy'))
        create(db, '--network-alias', 'mysql-mailcow', '-e', 'MARIADB_ROOT_PASSWORD=fixture-root',
               '-e', 'MARIADB_DATABASE=mailcow', '-e', 'MARIADB_USER=mailcow',
               '-e', 'MARIADB_PASSWORD=fixture-db', 'mariadb:10.11')
        docker('start', db)
        create(imap, '--network-alias', 'dovecot-mailcow', '--network-alias', 'postfix-mailcow',
               '--entrypoint', '/bin/sh', 'ghcr.io/mailcow/dovecot:2.3.21.1-4', '-c',
               'chmod 755 /fixture; chown -R 5000:5000 /fixture/mail; python3 /fixture/smtp.py & '
               'exec /usr/sbin/dovecot -F -c /fixture/dovecot.conf')
        docker('cp', str(fixture) + '/.', imap + ':/fixture')
        docker('start', imap)
        wait(lambda: '1' in docker('exec', db, 'mariadb', '-uroot', '-pfixture-root', '-Nse', 'SELECT 1'), 'MariaDB')
        create(rc, '--network-alias', 'roundcube-mailcow', '-e', 'ROUNDCUBEMAIL_DB_TYPE=mysql',
               '-e', 'ROUNDCUBEMAIL_DB_HOST=mysql-mailcow', '-e', 'ROUNDCUBEMAIL_DB_NAME=mailcow',
               '-e', 'ROUNDCUBEMAIL_DB_USER=mailcow', '-e', 'ROUNDCUBEMAIL_DB_PASSWORD=fixture-db',
               '-e', 'ROUNDCUBE_DES_KEY=abcdefghijklmnopqrstuvwx', '--entrypoint', '/bin/sh',
               'roundcube/roundcubemail:1.7.6-apache', '-c',
               'mkdir -p /var/www/html/plugins; '
               'cp /fixture/config.inc.php /var/roundcube/config/mailcow.inc.php; '
               'cp /fixture/healthcheck.php /var/www/html/healthcheck.php; '
               'cp -r /fixture/plugins/mailcow_sso /var/www/html/plugins/; '
               'exec /docker-entrypoint.sh apache2-foreground')
        docker('cp', str(ROOT / 'data/conf/roundcube') + '/.', rc + ':/fixture')
        docker('start', rc)
        wait(lambda: docker('exec', rc, 'php', '/var/www/html/healthcheck.php') == 'OK', 'Roundcube schema')
        site = (ROOT / 'data/conf/nginx/templates/sites-default.conf.j2').read_text()
        routes = site.split('# BEGIN ROUNDCUBE ROUTES', 1)[1].split('# END ROUNDCUBE ROUTES', 1)[0]
        routes = routes.replace('{{ NGINX_MAX_BODY_SIZE }}', '128m')
        credentials = {user: 'Basic ' + base64.b64encode(f'{user}@example.org:{PASSWORD}'.encode()).decode()
                       for user in ('alex', 'other')}
        config = 'events {}\nhttp {\nmap $remote_addr $mailcow_client_ip { default $remote_addr; }\n'
        config += 'map $scheme $client_req_scheme { default $scheme; }\n'
        config += ('map $cookie_fixture_user $fixture_auth { default ""; '
                   + ' '.join(f'{u} "{a}";' for u, a in credentials.items()) + ' }\n')
        config += ('server { listen 127.0.0.1:65510; location = /webmail-auth { '
                   'if ($fixture_auth = "") { return 401; } add_header X-Auth $fixture_auth; return 200; } }\n')
        config += 'server { listen 8080; ' + routes + ' location / { return 200 "portal"; } }\n}\n'
        (fixture / 'nginx.conf').write_text(config)
        create(proxy, '-p', '127.0.0.1::8080', '--entrypoint', 'nginx', 'nginx:alpine', '-g', 'daemon off;')
        docker('cp', str(fixture / 'nginx.conf'), proxy + ':/etc/nginx/nginx.conf')
        docker('start', proxy)
        port = json.loads(docker('inspect', proxy))[0]['NetworkSettings']['Ports']['8080/tcp'][0]['HostPort']
        url = f'http://127.0.0.1:{port}/webmail/'
        jar = http.cookiejar.CookieJar()
        browser = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        wait(lambda: browser.open(url).read() == b'portal', 'nginx session gate')
        # Client credentials do not replace the portal's authoritative header.
        request = urllib.request.Request(url, headers={'Authorization': credentials['alex'], 'X-User': 'alex@example.org'})
        assert browser.open(request).read() == b'portal', 'Spoofed headers bypassed the session gate'

        def inbox(user):
            cookie(jar, user)
            html = browser.open(url).read().decode()
            assert user + '@example.org' in html, html[-1500:]
            match = re.search(r'"request_token"\s*:\s*"([^"]+)"', html)
            assert match, 'Roundcube did not render an authenticated mailbox'
            token = match[1]
            query = urllib.parse.urlencode({'_task': 'mail', '_action': 'list', '_mbox': 'INBOX', '_remote': 1, '_token': token})
            response = browser.open(urllib.request.Request(url + '?' + query, headers={'X-Roundcube-Request': token})).read().decode()
            assert user.upper() + '_ONLY_MESSAGE' in response, response[-1500:]
            return token

        inbox('alex')
        # Exercise Roundcube's SMTP implementation with the production host/port config.
        smtp = '''define('INSTALL_PATH', '/var/www/html/');
require INSTALL_PATH . 'program/include/iniset.php';
$app = rcmail::get_instance();
$smtp = new rcube_smtp();
if (!$smtp->connect(null, null, 'alex@example.org', str_repeat('f', 32))) exit(1);
if (!$smtp->send_mail('alex@example.org', ['other@example.org'],
    "From: alex@example.org\\r\\nTo: other@example.org\\r\\nSubject: SMTP_RUNTIME_CHECK\\r\\n", 'Fixture send body.')) exit(2);
$smtp->disconnect(); echo 'SENT';'''
        assert docker('exec', rc, 'php', '-r', smtp) == 'SENT', 'Roundcube SMTP submission failed'
        assert 'SMTP_RUNTIME_CHECK' in docker('exec', imap, 'cat', '/fixture/sent.eml')
        token = inbox('other')  # Same browser/Roundcube cookie must switch to the other inbox.
        # Roundcube logout must hand over to the portal logout, or SSO signs back in on refresh.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs): return None
        logout = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect)
        try:
            logout.open(url + '?' + urllib.parse.urlencode({'_task': 'logout', '_token': token}))
            raise AssertionError('Roundcube logout did not redirect')
        except urllib.error.HTTPError as response:
            assert response.code == 303 and response.headers['Location'] == '/webmail.php?logout=1', \
                f'Roundcube logout stayed in webmail: {response.code} {response.headers.get("Location")}'
        cookie(jar, '')
        assert browser.open(url).read() == b'portal', 'A stale Roundcube cookie bypassed portal logout'
        columns = docker('exec', db, 'mariadb', '-uroot', '-pfixture-root', '-Nse',
                         'SHOW TABLES FROM mailcow')
        assert 'roundcube_users' in columns and '\nusers\n' not in '\n' + columns + '\n', columns
        print('Roundcube runtime passed: schema prefix, real IMAP inboxes, SMTP submission, SSO, account switching, header spoofing, logout gate.')


try:
    main()
except BaseException:
    for name in CONTAINERS:
        print(name + ':\n' + docker('logs', '--tail', '30', name, check=False))
    raise
finally:
    for name in reversed(CONTAINERS):
        docker('rm', '-fv', name, check=False)
    docker('network', 'rm', PREFIX, check=False)
