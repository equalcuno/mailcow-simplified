# Plates for mailcow

The Arevo design language, adapted to mailcow's existing PHP/Twig UI. This fork
defaults to Plates. No Node service, API credential, database migration, or new
authentication system is required. The existing PHP-FPM and nginx mounts serve it.

## Use and rollback

Open **Settings → UI** (`/admin/system#tab-ui`) to select the interface and
components. The UI tab also exists in Classic, so you can switch back there.

- **Plates / Classic** selects the overall interface.
- **Redesigned / Original** selects components within Plates. Redesigned is the
  default: dedicated login layouts, mail lists, focused create/edit forms, and Overview.
- Restyled mailcow buttons are used in both component modes.
- UI/component preferences are per browser and last one year. Business branding is
  instance-wide and requires an administrator.
- Set `$UI_PRESENTATION = 'stock';` or `$UI_COMPONENTS = 'original';` in
  `data/web/inc/vars.local.inc.php` to change defaults for browsers without preferences.

Direct overrides remain available: `/?ui=stock`, `/?ui=plates`, and
`/?ui=plates&components=redesigned` (or `components=original`). Clear
`mailcow_presentation` and `mailcow_components` cookies to follow instance defaults.

Settings → UI saves the business name into mailcow's existing `MAIN_NAME` and
`TITLE_NAME` settings and uploads logos through mailcow's existing logo handler.
Login and sidebar brand marks use those saved values. This is instance branding;
mailcow has no separate business-signup/tenant-branding model. The favicon accepts
square PNG/ICO files from 16–256 pixels, at most 256 KiB, and is stored in Redis.
Its save/reset forms use the existing admin session and CSRF checks. No host asset
file is overwritten. Domain administrators and mailbox users cannot mutate branding.

The redesigned login preserves user/admin/domain-admin routes, forced SSO,
OAuth/mobile configuration, announcements, reset-password links, and the native
WebAuthn hooks. Admins have a **Sign in with passkey** button. The page fits the
viewport; on very short or zoomed screens the form panel can scroll internally to
keep all controls reachable. The document itself does not scroll. Initial theme
and selected-view painting is held until the correct background/task is ready,
with a timeout that reveals content if enhancement fails.

Existing controls retain their translations. New copy defaults to English, with
German translations for the basic UI preferences. Dark mode follows mailcow's switch.

## Components and backend boundaries

`templates/` contains the original-component presentation. `redesigned/` overrides
individual views when that component mode is selected; it has its own login, lists
and forms. The new lists query the existing paginated search/alias endpoints.
Create/edit forms preserve native field names and delegated write handlers; they
do not replace login, MFA, permissions or CSRF. Advanced configuration stays available
in an expandable section using upstream templates, so the full feature set remains
accessible. `@upstream` always addresses those templates directly.

Domain rows offer **Domain setup** with expected and observed DNS values, required
checks, recommended client-discovery records, and **Recheck DNS**. A newly added
domain opens this panel after the native create flow reloads. The displayed status
stays **Setup needed** until the mail host's address/reverse DNS, primary MX, SPF,
DKIM and DMARC checks pass. Disabled domains remain inactive. This readiness display
does not change the native enabled flag or disable existing mail service. Checks
reuse the existing permission-checked DNS diagnostics endpoint with `format=json`,
cache observations for five minutes, and can be rechecked immediately. Lookup failures
never count as completed checks. Storage figures in the domain list use MiB/GiB.

Bulk mailbox creation shows password errors during review and reports results per
row. Invalid password/name/quota values do not stop other valid rows. Structural,
CSRF and domain-permission checks still run before any writes. Explicit preflight
rejections show **Not created**; interrupted writes remain **Outcome unconfirmed**.
Confirmed successful rows are retained for credential export and excluded from
subsequent submissions in the same dialog.

The fork adds small hooks in `inc/twig.inc.php`, `templates/base.twig`, and
`templates/admin.twig`, plus admin form handling in `inc/triggers.admin.inc.php`.
Template source freshness is checked so component switches/deployments do not serve
stale compiled layouts. The presentation lives outside the Git-ignored theme folders.

API additions:

- Optional `domain` on `POST /api/v1/search/mailbox`: an exact bound condition,
  composed with existing admin/domain-admin scope. Omitting it preserves behavior.
- **`GET /api/v1/get/overview`**: administrator-only, available to both read-only
  and read-write administrator API keys. Documented in `api/openapi.yaml`.
  It aggregates at most 20,000 retained Postfix entries from the last 24 hours,
  with explicit oldest/newest timestamps and scan coverage. It does not create
  durable audit/billing counters or invent a full day when logs cover less time.

Overview includes distinct successfully sent/local-delivery queue IDs, recipient
success/failure attempts, hourly activity, top sending/destination/local domains,
and current domain/mailbox/storage inventory. Sender rankings need retained queue
metadata. Local deliveries can include internal mail. Postfix delivery reports are
[recipient-oriented](https://www.postfix.org/smtp.8.html), so message and delivery
counts are shown separately. Host measurements and container status refresh every
five seconds through the administrator-only `/api/v1/get/overview/server` endpoint;
filesystem measurements are cached for 30 seconds. CPU, RAM, memory pressure and
filesystem graphs retain up to five minutes of measurements observed while the
page is open. Missing samples remain gaps. Mail activity/inventory refresh every
minute and on Refresh. Polling pauses in hidden tabs.

Domain rows include a DNS button beside the edit arrow. Icons try the domain's
HTTPS `/favicon.svg`, `/favicon.ico` and `/favicon.png`, then fall back to the globe.
Images load directly in the browser without a referrer; SVGs are never inlined.

The package is tracked under `ui/plates`, outside mailcow's Git-ignored theme
folders. Fonts are local Red Hat Text/Display assets with their OFL notice.
Message reading is provided by the selected Roundcube or SOGo service, separately from the management UI.

## Deploy or upgrade an existing instance

Use the root-level `upgrade.sh` to deploy the complete fork. It replaces the old
UI-only updater and handles the web UI, Compose services, Roundcube/SOGo selection,
configuration, cold backups and guarded recovery together.

```sh
sudo bash ./upgrade.sh --check
sudo bash ./upgrade.sh
sudo bash ./upgrade.sh --skip-roundcube  # preserve the current webmail client
sudo bash ./upgrade.sh --regress-sogo    # switch back to SOGo without deleting data
```

Commit and publish a tested fork release first; the script downloads its source
from the configured Git URL/ref, not from this working directory. See the
[installation and upgrade guide](../../../../README.md) for prerequisites, backups,
maintenance behavior, recovery, and the optional host worker behind the web update
button. The web update action preserves the selected client.

## Upstream updates

Treat this as a small downstream patch, not as an update-proof plugin. Upstream
can change the templates, JS contracts, API or extension hooks. The compatibility
manifest records dependencies that need review; matching hashes are a change
detector, not a guarantee that mailcow has no other relevant changes.

```sh
# After fetching an upstream release, optionally inspect before merging:
python3 helper-scripts/check-plates-compatibility.py --ref upstream/master

# After integrating upstream into a development branch:
python3 helper-scripts/check-plates-compatibility.py
php tests/ui/render.php
php tests/ui/metrics.php
npm --prefix tests/ui ci
npm --prefix tests/ui test

# Only after reviewing flagged changes and passing checks:
python3 helper-scripts/check-plates-compatibility.py --record
```

The render check uses the real vendored Twig and upstream templates, without a
running mail stack. Browser checks use isolated fixture data and existing browser
scripts; they do not connect to a production mail server. Their output can be used
as a local preview:

```sh
php tests/ui/render.php
php tests/ui/metrics.php
npm --prefix tests/ui run preview
# Open http://127.0.0.1:8765/admin/mailbox
```

PHP 8.2+ with `mbstring` and `pdo_sqlite`, Node 24+, and the dev-only dependencies
in `tests/ui` are used for checks. The preview server itself needs only Node and the
rendered fixtures. `PLATES_PREVIEW_DIR` selects their output directory in both tools.
The DOM checks can also be run independently with `npm --prefix tests/ui run test:dom`.
`npm --prefix tests/ui run test:native` runs the actual mailbox initializer,
DataTables and API handlers in Classic, Original components and redesigned
Advanced configuration, covering populated/empty alias lists and native writes.
The browser suite requires Chromium; Puppeteer installs it during `npm ci`.

Before deployment, also test login/MFA, domain-admin restrictions,
mailbox create/edit/delete, and quarantine against a staging mailcow instance.

Keep `origin` pointed at this fork and add official mailcow as `upstream` for
reviewed merges. The supplied `update.sh --force` can reset a fork's origin to
official mailcow, and its merge defaults favor upstream changes. Do not use it as
the deployment mechanism for an unreviewed customized branch. Integrate upstream,
run checks on staging, then deploy the tested fork release. Keep mailcow's own
update/migration procedures in that release process; a Git merge alone is not a
complete mailcow update. Back up data/configuration before stack upgrades.

To distribute this independently later, package `ui/plates` plus the small
core patches and run the same checks against each supported mailcow release.
Do not blindly reapply templates from a post-update hook.

## Real functional testing

The fixture preview never connects to real mail services. For a real nested mailcow
stack, use the [Docker-in-Docker harness](../../../../tests/live/README.md):

```sh
./helper-scripts/dev-mailcow-dind.sh up
# http://localhost:8080/admin (fresh DB: admin / moohoo)
./helper-scripts/dev-mailcow-dind.sh sync
./helper-scripts/dev-mailcow-dind.sh stop
```

This harness must still be exercised on a Docker-capable machine. Its command
construction/ownership guards have independent mocked checks; those do not prove
that the nested containers boot or that live authentication/mail delivery works.
