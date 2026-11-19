#!/usr/bin/env bash
set -euo pipefail
export DOCKER_HOST=unix:///var/run/docker.sock
cd /work
mkdir -p mailcow

sync_source() {
  # The launcher uploads only Git-tracked/unignored source, without host config.
  (cd /source; find . \( -type f -o -type l \) -print0) |
    rsync -a --delete-missing-args --from0 --files-from=- --exclude=node_modules --exclude=.git --exclude=mailcow.conf --exclude=vars.local.inc.php /source/ /work/mailcow/
  cd /work/mailcow
  if [[ ! -d .git ]]; then
    git init -b master
    git -c user.name='Mailcow local test' -c user.email='test@localhost' add .
    git -c user.name='Mailcow local test' -c user.email='test@localhost' commit -qm 'Local test source snapshot'
    git remote add origin .
    git update-ref refs/remotes/origin/master HEAD
    git branch --set-upstream-to=origin/master master
  fi
  ln -sfn mailcow.conf .env
  # Match the upstream PHP-FPM entrypoint after rsync restores source directory ownership.
  mkdir -p data/web/templates/cache
  find data/web/templates/cache -type f ! -name .gitkeep -delete
  chown -R 82:82 data/web/templates/cache
}

configure() {
  cd /work/mailcow
  if [[ ! -f mailcow.conf ]]; then
    # Non-interactive --dev preserves this working copy; never fetch/checkout upstream.
    MAILCOW_HOSTNAME=mail.dev.test MAILCOW_TZ=Etc/UTC SKIP_CLAMD=y ENABLE_IPV6=false \
      bash ./generate_config.sh --dev </dev/null
  fi
  set_config() {
    if grep -q "^$1=" mailcow.conf; then sed -i "s|^$1=.*|$1=$2|" mailcow.conf; else printf '%s=%s\n' "$1" "$2" >> mailcow.conf; fi
  }
  set_config COMPOSE_PROJECT_NAME mailcowuitest
  set_config MAILCOW_HOSTNAME mail.dev.test
  set_config HTTP_BIND 0.0.0.0
  set_config HTTPS_BIND 0.0.0.0
  set_config HTTP_PORT 80
  set_config HTTPS_PORT 443
  set_config HTTP_REDIRECT n
  set_config ADDITIONAL_SERVER_NAMES localhost
  set_config IPV4_NETWORK 172.30.51
  set_config ENABLE_IPV6 false
  set_config SKIP_LETS_ENCRYPT y
  set_config SKIP_IP_CHECK y
  set_config SKIP_HTTP_VERIFICATION y
  set_config SKIP_UNBOUND_HEALTHCHECK y
  set_config SKIP_CLAMD y
  set_config SKIP_OLEFY y
  set_config SKIP_FTS y
  set_config USE_WATCHDOG n
  set_config LOG_LINES 20000
  if ! grep -q '^WEBMAIL_CLIENT=' mailcow.conf; then set_config WEBMAIL_CLIENT roundcube; fi
  WEBMAIL_CLIENT=$(sed -n 's/^WEBMAIL_CLIENT=//p' mailcow.conf)
  [[ $WEBMAIL_CLIENT == sogo || $WEBMAIL_CLIENT == roundcube ]] || { echo 'Invalid test webmail client.' >&2; exit 1; }
  set_config COMPOSE_PROFILES "$WEBMAIL_CLIENT"
  if [[ $WEBMAIL_CLIENT == sogo ]]; then set_config SKIP_SOGO n; else set_config SKIP_SOGO y; fi
  if ! grep -q '^ROUNDCUBE_DES_KEY=.' mailcow.conf; then set_config ROUNDCUBE_DES_KEY "$(openssl rand -hex 12)"; fi
  cat > docker-compose.override.yml <<'YAML'
services:
  php-fpm-mailcow:
    command: ["php-fpm", "-d", "date.timezone=Etc/UTC", "-d", "expose_php=0", "-d", "opcache.enable=0"]
    environment:
      DEV_MODE: "y"
YAML
}

stop_former_webmail() {
  local former=sogo
  [[ $WEBMAIL_CLIENT == sogo ]] && former=roundcube
  docker compose --profile "$former" stop "$former-mailcow"
  docker compose --profile "$former" rm -f "$former-mailcow"
}

block_external_mail() {
  # These rules exist only in the nested daemon's network namespace.
  # Local mailbox-to-mailbox tests still work; Internet SMTP is blocked.
  iptables -N MAILCOW_TEST_OUTBOUND 2>/dev/null || true
  iptables -F MAILCOW_TEST_OUTBOUND
  iptables -A MAILCOW_TEST_OUTBOUND -d 172.30.51.0/24 -j RETURN
  iptables -A MAILCOW_TEST_OUTBOUND -p tcp -m multiport --dports 25,465,587 -j REJECT
  iptables -A MAILCOW_TEST_OUTBOUND -j RETURN
  iptables -C DOCKER-USER -j MAILCOW_TEST_OUTBOUND 2>/dev/null || iptables -I DOCKER-USER 1 -j MAILCOW_TEST_OUTBOUND
}

case "${1:-up}" in
  up)
    sync_source
    configure
    docker compose config --quiet
    printf 'Pulling mailcow images into the nested daemon…\n'
    docker compose pull
    stop_former_webmail
    docker compose up -d
    block_external_mail
    printf 'Waiting for the real mailcow login (database/schema initialization can take several minutes)…\n'
    for ((attempt=0; attempt<300; attempt++)); do
      if curl --silent --fail --max-time 5 http://127.0.0.1/admin -o /dev/null; then
        printf 'Mailcow test instance is ready. Fresh database credentials: admin / moohoo\n'
        exit 0
      fi
      sleep 2
    done
    docker compose ps
    printf 'The UI did not become ready in time. Inspect the test instance logs.\n' >&2
    exit 1
    ;;
  sync)
    sync_source
    configure
    stop_former_webmail
    docker compose up -d
    block_external_mail
    printf 'Working-copy changes copied into the test stack. Refresh the browser.\n'
    ;;
  stop) cd /work/mailcow; docker compose stop --timeout 45 ;;
  status) cd /work/mailcow; docker compose ps ;;
  logs) shift; cd /work/mailcow; docker compose logs --tail 120 --follow "$@" ;;
  shell) cd /work/mailcow; exec bash ;;
  *) printf 'Unknown inner command\n' >&2; exit 2 ;;
esac
