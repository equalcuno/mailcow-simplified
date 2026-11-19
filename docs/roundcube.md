# Roundcube webmail

This fork replaces the running SOGo service with the official
`roundcube/roundcubemail:1.7.6-apache` image, served at `/webmail/`. Roundcube uses
the existing Dovecot mailboxes, Postfix submission, and ManageSieve service.
Messages, folders, quotas, passwords, aliases, and existing Sieve scripts stay in
Mailcow. Roundcube metadata uses `roundcube_` tables in the existing MariaDB
database, so the normal MySQL backup includes identities, preferences, contacts,
and sessions. No separate database server is required.

## Existing installations

Use the unified [upgrade workflow](../README.md#upgrade-an-existing-mailcow-instance):

```sh
sudo bash ./upgrade.sh --check
sudo bash ./upgrade.sh                    # use Roundcube
sudo bash ./upgrade.sh --skip-roundcube   # keep the existing client
sudo bash ./upgrade.sh --regress-sogo     # return to SOGo
```

The flags are mutually exclusive. Upgrades change the complete fork and preserve
instance configuration, credentials and Docker volumes. Cold file/volume/image
backups and health checks are handled by the same engine as the overview update
button. Only one selected webmail profile runs at the reserved `.248` address.
`WEBMAIL_CLIENT`, `COMPOSE_PROFILES` and `SKIP_SOGO` are maintained together.
The historical `migrate-to-roundcube.sh` entry point delegates to `upgrade.sh`.

SOGo's original image, routing, authentication integration and data are retained
for installations using `--skip-roundcube` or `--regress-sogo`. Returning to SOGo
is a forward deployment of the current fork, not a historical database restore.
Roundcube contacts/preferences are retained independently. There is no automatic
cross-client contacts/calendar conversion.

## Login and permissions

Users sign in through the existing Mailcow login, including MFA, identity-provider
login, and required password/2FA enrollment. Roundcube does not expose a second
password login that could bypass these policies. Nginx revalidates the portal
session for every webmail request; ending the portal session removes access even
when a Roundcube cookie remains. Roundcube's logout returns to the portal account
page; use the portal's Sign out to end the Mailcow session as well.

The mailbox's existing `sogo_access` setting is now labelled **Webmail access**.
Its database/API name is retained for compatibility. Disabled mailboxes/domains,
pending MFA/password actions, API-key sessions, and out-of-scope targets are denied.
The existing `ALLOW_ADMIN_EMAIL_LOGIN=y` setting and `login_as` permission control
administrator access. Domain administrators retain their original tenant scope,
including when using dual-login. Switching mailboxes clears the previous Roundcube
session before opening the selected inbox.

The dedicated Roundcube container has no published ports. It reuses Dovecot's
existing, source-restricted `.248` SSO path and internal SMTP submission on port
588. The historical `sogo-sso.pass` filename and trusted-IP configuration remain
because the pinned Dovecot image generates them. Nginx overwrites Authorization;
browser-supplied credentials and identity headers are not trusted. The internal
credential is refreshed per request and removed before persisting Roundcube sessions.
Do not assign `.248` to another service or publish the Roundcube container directly.

## Features and retained SOGo data

Roundcube provides mail, local contacts, folders, attachments, identities, shared
folder ACLs, spam marking, vacation replies, forwarding, and filter editing through
ManageSieve. The **existing** filter sets remain on Dovecot; inspect them before
activating a new filter set. Changing a password remains in Mailcow's account page.

Roundcube does not replace SOGo's CalDAV/CardDAV server, calendars, or Exchange
ActiveSync. In Roundcube mode, discovery no longer advertises those protocols and their endpoints
return HTTP 410. SOGo mode continues to provide its DAV/ActiveSync routes. Configure mobile/desktop clients with IMAP/SMTP. Old `/SOGo/so/`
bookmarks redirect to `/webmail/`.

In Roundcube mode, no SOGo tables or data volumes are deleted. Its contacts, calendars, preferences,
and sharing settings are retained but are not automatically imported or synchronized.
Import exported vCards into Roundcube's Contacts. Keep ICS exports for a separate
calendar service; Roundcube's bundled mail application has no calendar server.

## Verification and recovery

After migration, test normal login, MFA, mandatory password changes, allowed/denied
admin access, account switching, message reading, SMTP sending, attachments,
folders, filters, and logout. Check service readiness with:

```sh
docker compose ps
docker compose logs --tail=100 roundcube-mailcow nginx-mailcow php-fpm-mailcow
docker compose exec -T roundcube-mailcow php /var/www/html/healthcheck.php
```

To return to SOGo, run `sudo bash ./upgrade.sh --regress-sogo`. The same guarded
backup/health-check process applies. To recover an interrupted deployment, follow
the root README's worker/journal recovery instructions. Do not delete volumes.

## Development checks

```sh
php tests/ui/webmail.php
python3 tests/live/test_upgrade.py
php tests/ui/render.php
php tests/ui/metrics.php
npm --prefix tests/ui ci
npm --prefix tests/ui test
```

The policy/plugin tests isolate authentication boundaries; `test_upgrade.py`
injects failures with Docker/firewall doubles. Opt-in `test_roundcube_runtime.py`
and `test_upgrade_runtime.py` exercise real services and an isolated Docker daemon.
See the [live checks](../tests/live/README.md). These do not replace acceptance checks
against a complete staging instance, especially systemd boot recovery.

References: [Roundcube Docker configuration](https://github.com/roundcube/roundcubemail-docker),
[Roundcube release notes](https://github.com/roundcube/roundcubemail/releases/tag/1.7.6),
and [Mailcow Roundcube integration](https://docs.mailcow.email/third_party/roundcube/third_party-roundcube/).
