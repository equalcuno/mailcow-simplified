# Real mailcow in Docker-in-Docker

From this fork's root, with a running local Docker engine:

```sh
./helper-scripts/dev-mailcow-dind.sh up
```

Open **http://localhost:8080/admin**. A fresh test database uses mailcow's default
`admin` / `moohoo` login. Initial image downloads and database setup take time.
The TLS endpoint is https://localhost:8443 with a generated self-signed certificate.
Use the localhost URL consistently when registering and testing passkeys.

If the first build fails with `lookup registry-1.docker.io: no such host`, the
host Docker VM cannot resolve Docker Hub. This happens before DinD starts.
For Colima, the [official DNS troubleshooting guidance](https://github.com/abiosoft/colima/blob/main/docs/FAQ.md)
recommends restarting with explicit resolvers:

```sh
colima stop
colima start --dns 1.1.1.1 --dns 8.8.8.8
docker pull docker:28-dind
./helper-scripts/dev-mailcow-dind.sh up
```

Restarting Colima interrupts all containers in that profile but preserves their
data. Use your network's permitted DNS servers if public resolvers are blocked.
You can check resolution inside the VM with
`colima ssh -- getent hosts registry-1.docker.io`.

This is a real mailcow Compose deployment, not the fixture preview. The outer
container runs a separate Docker daemon and stores all nested containers/volumes
in its own named volume. It uses `--privileged`, as required by the official
[Docker-in-Docker image](https://hub.docker.com/_/docker); run it only as a local
development environment. Docker Desktop's Linux VM runs the nested Linux stack
on macOS. Allocate enough resources for the [mailcow requirements](https://docs.mailcow.email/getstarted/prerequisite-system/).
ClamAV, Olefy and full-text indexing are disabled for this test profile; SOGo,
Postfix, Dovecot, Rspamd, MariaDB and Redis are real services.

The launcher uploads a snapshot of Git-tracked and unignored files through Docker
into `/source`, then copies them into `/work/mailcow`. No host bind mount is
required, including when the repository is outside Colima's shared folders.
Host `mailcow.conf`, local overrides,
ignored certificates and test dependency directories are excluded. A fresh config
and certificate are generated inside the test volume. The host Docker socket is
never mounted. PHP OPcache is disabled in this development profile so synced PHP
changes are picked up immediately. Source edits are applied explicitly:

```sh
./helper-scripts/dev-mailcow-dind.sh sync
./helper-scripts/dev-mailcow-dind.sh status
./helper-scripts/dev-mailcow-dind.sh logs php-fpm-mailcow
./helper-scripts/dev-mailcow-dind.sh shell
./helper-scripts/dev-mailcow-dind.sh stop
# Resume, retaining test accounts/mail/branding:
./helper-scripts/dev-mailcow-dind.sh up
```

Every published port binds to `127.0.0.1`: HTTP 8080, HTTPS 8443, SMTP 1025,
submission 1587, IMAP 1143, IMAPS 1993. The nested Docker API is Unix-socket-only.
Internet SMTP on ports 25/465/587 is blocked inside the nested daemon; mailcow's
private subnet is permitted for local delivery tests. Do not use this profile as
a public mail server. Configure `.test` domains/mailboxes through the real UI,
send mail between them, and inspect Overview, quarantine, account settings and
both UI modes. Successful outbound-delivery metrics need a reachable test SMTP
peer inside the nested network; mail to Internet destinations will defer.

After creating `example.test` and the two mailboxes below, a local delivery test
from the harness shell can exercise Postfix, Rspamd, Dovecot and Overview:

```sh
python3 - <<'PY'
from email.message import EmailMessage
from smtplib import SMTP
message = EmailMessage()
message['From'] = 'alice@example.test'
message['To'] = 'bob@example.test'
message['Subject'] = 'Local mailcow functional test'
message.set_content('This message stays in the local test stack.')
with SMTP('127.0.0.1', 25) as smtp:
    smtp.send_message(message)
PY
```

In the shell, the actual test installation is `/work/mailcow`; use `docker compose`
there to inspect containers or perform controlled test setup. Instance data is
preserved across `stop` and `down`. The `reset` command removes only the named,
ownership-labelled harness container and its two data volumes:

```sh
./helper-scripts/dev-mailcow-dind.sh down
./helper-scripts/dev-mailcow-dind.sh reset --yes
```

Inspect the launch commands without Docker access:

```sh
./helper-scripts/dev-mailcow-dind.sh up --dry-run
python3 tests/live/test_harness.py
```

Use `--name NAME --http-port 8090 --https-port 8490` for a separate environment;
set `MAILCOW_DIND_SMTP_PORT`, `MAILCOW_DIND_SUBMISSION_PORT`, `MAILCOW_DIND_IMAP_PORT`
and `MAILCOW_DIND_IMAPS_PORT` too when running multiple instances. Changing published
ports or the harness image requires `down` then `up` with the same flags.
`MAILCOW_DIND_BASE` overrides `docker:28-dind`; `MAILCOW_DIND_STORAGE_DRIVER=vfs`
provides a slower fallback where nested overlay2 is unsupported. After changing
`tests/live/manage.sh` or its Dockerfile, recreate the outer container with `down`
and `up` to rebuild the harness. Test data stays in the named volumes.
