# Mailcow Simplified

A fork of [mailcow: dockerized](https://github.com/mailcow/mailcow-dockerized) with
an integrated management interface, selectable Roundcube/SOGo webmail, and a full
upgrade workflow with verified backups and recovery.

This is the public fork. Instance names, business logos and favicons belong in
**Settings → UI**; personal branding is not bundled with the repository.

## What changes

- **Plates interface:** redesigned login, overview, domain/mailbox/alias lists and
  focused forms, with the original Mailcow controls available under Advanced.
- **Webmail choice:** Roundcube is the default. Existing SOGo installations can
  keep SOGo, and Roundcube instances can switch back without deleting either
  application's stored data.
- **Existing authentication:** Mailcow accounts, permissions, MFA and required
  password changes remain authoritative. Permitted administrator login-as is
  supported; domain administrators retain their domain boundaries.
- **Overview:** CPU, memory, Linux memory pressure, mail filesystem capacity,
  service status, retained mail activity, delivery errors and measured send timings.
  Missing telemetry/timing samples are shown as unavailable.
- **Mailbox management:** bulk creation with review and per-mailbox outcomes,
  persistent domain filters, and passwords generated from 16 random bytes
  (32 hexadecimal characters). Existing server password rules still apply.
- **Upgrades:** `upgrade.sh` handles code, UI, Compose services and webmail changes
  together. An optional host worker exposes the same engine through the overview's
  **Update server** button.

Mailcow's mail transport, mailbox storage, spam filtering, antivirus, quotas,
API and account-management backend remain the foundation of this fork.

## Requirements

Use a supported Linux Mailcow host with Git, Python 3.8+, Docker Engine 24+ and
Docker Compose **2.24.4+**. The full upgrader requires root, GNU tar, `iptables`
and `ip6tables`, systemd, a local Docker Engine using its `DOCKER-USER` firewall hook, and
space outside the installation for full backups of files, volumes and images.
The upgrader registers a root-owned pre-Docker recovery guard before the first transaction; the worker uses systemd too.

See Mailcow's [system requirements](https://docs.mailcow.email/getstarted/prerequisite-system/),
[DNS setup](https://docs.mailcow.email/getstarted/prerequisite-dns/) and
[installation guide](https://docs.mailcow.email/getstarted/install/) for host
sizing, ports, DNS and certificate prerequisites. Use this fork's commands below
when choosing code, webmail and upgrade paths.

## Fresh installation

On the server, as root:

```sh
cd /opt
git clone --branch master https://github.com/equalcuno/mailcow-simplified.git
cd mailcow-simplified
# The repository normally includes this symlink; create it only if absent.
[ -L .env ] || ln -s mailcow.conf .env
./generate_config.sh --dev
```

Enter the server's fully qualified hostname and timezone, then review
`mailcow.conf`. `--dev` here keeps the selected fork checkout; it does not enable
Mailcow's runtime development mode. Fresh configuration selects Roundcube and
generates its persistent encryption key.

```sh
docker compose pull
docker compose up -d
docker compose ps
```

Open `https://YOUR_MAIL_HOST/admin`, change the initial administrator password,
configure MFA, add your domains/mailboxes, and publish the DKIM/DNS records shown
by Mailcow. Test inbound and outbound delivery. Mailbox users sign in through the
normal login and open webmail at `/webmail/`.

Keep `mailcow.conf`, its database/Redis passwords, `ROUNDCUBE_DES_KEY`, local
configuration and Docker volumes with your backups. Do not commit them.

## Upgrade an existing Mailcow instance

Upgrade **in the existing installation directory**. Keep its `mailcow.conf`,
`COMPOSE_PROJECT_NAME`, hostname, credentials, local overrides and Docker volumes.
Do not run `generate_config.sh` again or create a second instance for the upgrade.

First export SOGo contacts/calendars if you plan to switch clients. Take a normal
Mailcow backup and record the current Git revision before the initial conversion.
Review local changes; the upgrader requires clean tracked files and a release
that descends from the installed revision. Diverged/custom branches need a
reviewed merge into the fork before deployment.
The installation's Compose files and `mailcow.conf` must be root-owned and must
not be group/world-writable. Keep the backup and worker-state directories outside
the installation and writable only by root.

Download the standalone upgrader from the fork, then validate:

```sh
cd /opt/mailcow-dockerized  # use your actual existing installation directory
curl -fsSLo /tmp/mailcow-upgrade.sh \
  https://raw.githubusercontent.com/equalcuno/mailcow-simplified/master/upgrade.sh
sudo bash /tmp/mailcow-upgrade.sh --target "$PWD" --check
```

Choose the webmail behavior:

```sh
# Upgrade the complete fork; migrate SOGo to Roundcube.
sudo bash /tmp/mailcow-upgrade.sh --target "$PWD"

# Upgrade everything while keeping the currently selected webmail client.
sudo bash /tmp/mailcow-upgrade.sh --target "$PWD" --skip-roundcube

# Upgrade the fork and switch back to SOGo, retaining Roundcube data.
sudo bash /tmp/mailcow-upgrade.sh --target "$PWD" --regress-sogo
```

The two webmail flags are mutually exclusive. To pin a tested release or choose
the backup destination, add `--ref YOUR_RELEASE_TAG` and
`--backup-dir /srv/mailcow-backups`. `--repo` accepts another trusted fork URL,
including SSH when the account running the script has repository access.
The downloaded temporary checkout is cleaned up when the command exits. The
first full upgrade installs the root-owned recovery service before pausing mail;
this lets unfinished transactions stay isolated across Docker/host restarts.

### What the upgrade does

1. Downloads the fork, validates the selected release/configuration and pulls
   images before pausing mail access.
2. Guards external mail/web connections and stops this instance's services.
3. Creates a cold backup of installation files, project-owned named volumes and previous
   container images, then verifies archive checksums.
4. Installs the complete release and selected webmail configuration. It starts an
   isolated stack without published ports and runs readiness checks.
5. Recreates the normal service bindings, checks readiness again while access is
   still guarded, and reopens connections only after the commit point.

A failure before commit restores the previous stack/data while connections remain
blocked. If recovery itself fails, access stays guarded and the private transaction
journal identifies the retained backup. After commit, cleanup does not restore
older mail data over newly accepted messages. Existing backups are not pruned.

Plan a maintenance window: all Mailcow services pause during the cold backup and
checks, and backup duration depends on mailbox size. Other mail servers retry
connections during the outage. Writable bind mounts outside the installation,
shared/external volumes, extra service networks, local image builds and network
layout changes require a separately reviewed deployment instead of an automatic
upgrade. Do not run other deployment/cleanup tools concurrently.

`update-ui.sh` has been replaced by **`upgrade.sh`**. Do not use upstream
`update.sh --force` for this fork: its remote/merge behavior can discard downstream
changes. Integrate and test upstream Mailcow changes in this repository, then
publish a fork release for the upgrader to install.

## Update from the overview

Install the optional root-owned worker once on the Linux server:

```sh
sudo bash helper-scripts/install-upgrade-worker.sh
sudo systemctl status mailcow-simplified-updates.service
```

Review `/etc/mailcow-simplified-updates.json` for the trusted repo/ref, backup
location, state directory and disk-space reserve. The service account needs Git
access to that repo. The installer also registers a pre-Docker traffic guard for
unfinished transactions after a reboot; it does not restart Docker at installation.

The overview's **Update server** action is available only to a fully authenticated
administrator, requires CSRF protection and review of the release, and queues one
job at a time. It preserves the selected webmail client. The web process does not
receive a host Docker socket. The page may become unavailable during maintenance;
the host worker and journal continue independently.

```sh
sudo journalctl -u mailcow-simplified-updates.service -n 100
# Recover an unfinished transaction after inspecting the journal/backups:
sudo python3 /usr/local/lib/mailcow-simplified-updates/worker.py --recover
```

The private backup also contains `recover.py` and `engine-config.json`; use those
with `--recover --config PATH_TO_CONFIG` if the installed worker files are unavailable.
Recovery is for unfinished transactions, not for
replacing current mail with an arbitrary historical snapshot.

## Roundcube and SOGo

Both clients use the same Dovecot mailboxes and Postfix service, so email does not
need copying when switching. Only one client runs at the reserved internal `.248`
address. `upgrade.sh` maintains `WEBMAIL_CLIENT`, `COMPOSE_PROFILES` and
`SKIP_SOGO` together; avoid editing only one of those values by hand.

Roundcube provides mail, local contacts, attachments, folders, shared-folder ACLs
and ManageSieve filters/vacation replies. It does not provide SOGo's CalDAV/CardDAV
server, calendars or ActiveSync. Those endpoints stop being advertised in
Roundcube mode. Use IMAP/SMTP clients or keep SOGo with `--skip-roundcube` when
you need its groupware services.

SOGo tables/volumes and Roundcube metadata are retained across client switches.
Contacts, calendars, preferences and sharing settings are **not automatically
converted or synchronized**. Export/import contacts as vCards; retain calendar
ICS exports for a calendar service. Returning to SOGo reuses its retained data,
including its calendars, but does not import new Roundcube contacts.

See the [webmail integration guide](docs/roundcube.md) for authentication,
verification and data-handling details.

## Interface and personal branding

**Settings → UI** selects Plates or Classic and redesigned/original components.
Selections are per browser. Business names, uploaded logos and favicons apply to
the instance. Set your own branding there; the repository remains generic.
`/?ui=stock` opens the classic interface, and `/?ui=plates` selects Plates.

The [presentation guide](data/web/ui/plates/README.md) covers UI preferences,
backend boundaries and upstream compatibility review.

## Development and validation

```sh
python3 helper-scripts/check-plates-compatibility.py
php tests/ui/render.php
php tests/ui/metrics.php
php tests/ui/webmail.php
npm --prefix tests/ui ci
npm --prefix tests/ui test
```

The [DinD harness](tests/live/README.md) runs an isolated Mailcow stack. The
opt-in `python3 tests/live/test_roundcube_runtime.py` check runs real Roundcube,
MariaDB, Dovecot and nginx with fixture mail data and a fixture SMTP service.
Do not run development fixtures against production mail accounts.

## Upstream and licensing

Mailcow Simplified is an independent downstream fork. Mailcow is developed by
The Infrastructure Company GmbH; this repository retains its original licensing
and attribution. Mailcow itself is licensed under GPLv3; bundled components retain
their own licenses. See [LICENSE](LICENSE) and the
[upstream project](https://github.com/mailcow/mailcow-dockerized).
