#!/usr/bin/env bash
# Real local mailcow stack inside a separate Docker daemon. macOS Bash 3 compatible.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
INSTANCE=${MAILCOW_DIND_NAME:-mailcow-ui-test}
HTTP_PORT=${MAILCOW_DIND_HTTP_PORT:-8080}
HTTPS_PORT=${MAILCOW_DIND_HTTPS_PORT:-8443}
SMTP_PORT=${MAILCOW_DIND_SMTP_PORT:-1025}
SUBMISSION_PORT=${MAILCOW_DIND_SUBMISSION_PORT:-1587}
IMAP_PORT=${MAILCOW_DIND_IMAP_PORT:-1143}
IMAPS_PORT=${MAILCOW_DIND_IMAPS_PORT:-1993}
DIND_BASE=${MAILCOW_DIND_BASE:-docker:28-dind}
STORAGE_DRIVER=${MAILCOW_DIND_STORAGE_DRIVER:-overlay2}
DRY_RUN=false
ASSUME_YES=false
ACTION=up

usage() {
  cat <<'HELP'
Usage: helper-scripts/dev-mailcow-dind.sh [up|sync|status|logs|shell|stop|down|reset] [options]
  up                 Build/start the nested daemon and real mailcow stack (default)
  sync               Copy current tracked/unignored source changes into the running stack
  status             Show real inner service status
  logs [service]     Follow the inner stack logs (Ctrl+C leaves the stack running)
  shell              Open Bash inside the test installation
  stop               Stop services and the nested daemon, preserving test data
  down               Remove the test container, preserving test data volumes
  reset --yes        Remove only this harness's container and its two data volumes
Options:
  --name NAME        Separate named test environment (default mailcow-ui-test)
  --http-port PORT   Browser port (default 8080)
  --https-port PORT  TLS browser port (default 8443)
  --dry-run          Print commands without Docker access or changes
  --yes              Confirm deletion for reset

All published ports bind to 127.0.0.1. No host Docker socket is mounted.
DinD uses --privileged; this harness is for local development.
HELP
}
if [[ $# -gt 0 && "$1" != -* ]]; then ACTION=$1; shift; fi
SERVICE=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name|--http-port|--https-port)
      [[ $# -ge 2 ]] || { printf 'Missing option value\n' >&2; exit 2; }
      case "$1" in --name) INSTANCE=$2 ;; --http-port) HTTP_PORT=$2 ;; --https-port) HTTPS_PORT=$2 ;; esac
      shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --yes) ASSUME_YES=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) if [[ "$ACTION" == logs && -z "$SERVICE" && "$1" != -* ]]; then SERVICE=$1; shift; else usage >&2; exit 2; fi ;;
  esac
done
[[ "$INSTANCE" =~ ^[a-z0-9][a-z0-9_.-]*$ ]] || { printf 'Invalid instance name\n' >&2; exit 2; }
[[ "$STORAGE_DRIVER" == overlay2 || "$STORAGE_DRIVER" == vfs ]] || { printf 'Storage driver must be overlay2 or vfs\n' >&2; exit 2; }
for port in "$HTTP_PORT" "$HTTPS_PORT" "$SMTP_PORT" "$SUBMISSION_PORT" "$IMAP_PORT" "$IMAPS_PORT"; do
  [[ "$port" =~ ^[0-9]{1,5}$ ]] && ((10#$port > 0 && 10#$port < 65536)) || { printf 'Invalid port: %s\n' "$port" >&2; exit 2; }
done
case "$ACTION" in up|sync|status|logs|shell|stop|down|reset) ;; *) usage >&2; exit 2 ;; esac
IMAGE="${INSTANCE}-harness"
DATA_VOLUME="${INSTANCE}-docker"
WORK_VOLUME="${INSTANCE}-work"
LABEL=com.mailcow.plates.dind
SOURCE_LABEL=com.mailcow.plates.source
COPY_LABEL=com.mailcow.plates.source-copy
run() {
  if "$DRY_RUN"; then printf '  '; printf '%q ' "$@"; printf '\n'; else "$@"; fi
}
if ! "$DRY_RUN"; then
  command -v docker >/dev/null || { printf 'Docker is required. Start Docker Desktop or a Linux Docker engine.\n' >&2; exit 1; }
  docker info >/dev/null || { printf 'Cannot access Docker. Start the Docker engine first.\n' >&2; exit 1; }
fi
exists() { ! "$DRY_RUN" && docker container inspect "$INSTANCE" >/dev/null 2>&1; }
owned_container() {
  "$DRY_RUN" && return
  if ! exists; then
    printf 'Test container %s does not exist in the current Docker context.\nRun %q up --name %q to create it.\n' "$INSTANCE" "$0" "$INSTANCE" >&2
    exit 1
  fi
  [[ $(docker inspect -f "{{ index .Config.Labels \"$LABEL\" }}" "$INSTANCE") == true && $(docker inspect -f "{{ index .Config.Labels \"$SOURCE_LABEL\" }}" "$INSTANCE") == "$ROOT" ]] || { printf 'Refusing to use an unrelated container named %s\n' "$INSTANCE" >&2; exit 1; }
}
volume() {
  local name=$1
  if ! "$DRY_RUN" && docker volume inspect "$name" >/dev/null 2>&1; then
    [[ $(docker volume inspect -f "{{ index .Labels \"$LABEL\" }}" "$name") == true && $(docker volume inspect -f "{{ index .Labels \"$SOURCE_LABEL\" }}" "$name") == "$ROOT" ]] || { printf 'Refusing to use an unrelated volume named %s\n' "$name" >&2; exit 1; }
  else run docker volume create --label "$LABEL=true" --label "$SOURCE_LABEL=$ROOT" "$name"; fi
}
require_running() {
  owned_container
  "$DRY_RUN" && return
  [[ $(docker inspect -f '{{ .State.Running }}' "$INSTANCE") == true ]] || {
    printf 'Test container %s is stopped. Run %q up --name %q to resume it.\n' "$INSTANCE" "$0" "$INSTANCE" >&2
    exit 1
  }
}
inner() { run docker exec "$INSTANCE" /harness/manage.sh "$@"; }
require_source_copy() {
  "$DRY_RUN" && return
  [[ $(docker inspect -f "{{ index .Config.Labels \"$COPY_LABEL\" }}" "$INSTANCE") == true ]] || {
    printf 'This instance uses the old source mount. Run down then up to recreate it; test data is preserved.\n' >&2
    exit 1
  }
}
copy_source() (
  if "$DRY_RUN"; then
    printf '  Copy Git-tracked and unignored source through Docker (no host bind mount)\n'
    return
  fi
  require_source_copy
  local snapshot
  snapshot=$(mktemp "${TMPDIR:-/tmp}/mailcow-source.XXXXXX")
  trap 'rm -f "$snapshot"' EXIT
  # Build the archive on the client, so Docker's VM need not share the repo path.
  git -C "$ROOT" ls-files -z --cached --others --exclude-standard |
    while IFS= read -r -d '' path; do
      if [[ -f "$ROOT/$path" || -L "$ROOT/$path" ]]; then printf '%s\0' "$path"; fi
    done |
    tar -C "$ROOT" --exclude=node_modules --exclude=.git --exclude=mailcow.conf \
      --exclude=vars.local.inc.php --null -T - -cf "$snapshot"
  # Extract in the exec process's mount namespace; no intermediate container path.
  run docker exec -i "$INSTANCE" bash -e -c 'mkdir -p /source; find /source -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xf - -C /source' < "$snapshot"
)

case "$ACTION" in
  up)
    if exists; then
      owned_container
      require_source_copy
      existing_http=$(docker inspect -f '{{ (index (index .HostConfig.PortBindings "80/tcp") 0).HostPort }}' "$INSTANCE")
      existing_https=$(docker inspect -f '{{ (index (index .HostConfig.PortBindings "443/tcp") 0).HostPort }}' "$INSTANCE")
      [[ "$existing_http" == "$HTTP_PORT" && "$existing_https" == "$HTTPS_PORT" ]] || { printf 'Existing test instance uses different ports. Use the original flags or down then up to change them.\n' >&2; exit 1; }
      run docker start "$INSTANCE"
    else
      if ! run docker build --build-arg "DIND_BASE=$DIND_BASE" -t "$IMAGE" "$ROOT/tests/live"; then
        cat >&2 <<'DIAGNOSTIC'

The harness image could not be built; the test stack has not been started.
If Docker reported "no such host", its VM cannot resolve the image registry.
For Colima, inspect DNS with:
  colima ssh -- getent hosts registry-1.docker.io
The Colima FAQ recommends explicit DNS servers when its default resolver fails:
  colima stop
  colima start --dns 1.1.1.1 --dns 8.8.8.8
This restarts all workloads in that Colima profile; it does not delete their data.
Then retry this launcher. For other build errors, use the Docker error above.
DIAGNOSTIC
        exit 1
      fi
      volume "$DATA_VOLUME"; volume "$WORK_VOLUME"
      run docker run -d --privileged --name "$INSTANCE" \
        --label "$LABEL=true" --label "$SOURCE_LABEL=$ROOT" \
        --label "$COPY_LABEL=true" \
        --mount "type=volume,source=$DATA_VOLUME,target=/var/lib/docker" \
        --mount "type=volume,source=$WORK_VOLUME,target=/work" \
        --publish "127.0.0.1:$HTTP_PORT:80" --publish "127.0.0.1:$HTTPS_PORT:443" \
        --publish "127.0.0.1:$SMTP_PORT:25" --publish "127.0.0.1:$SUBMISSION_PORT:587" \
        --publish "127.0.0.1:$IMAP_PORT:143" --publish "127.0.0.1:$IMAPS_PORT:993" \
        --env DOCKER_TLS_CERTDIR= "$IMAGE" dockerd \
        --host=unix:///var/run/docker.sock --storage-driver="$STORAGE_DRIVER"
    fi
    if ! "$DRY_RUN"; then
      ready=false
      for ((attempt=0; attempt<60; attempt++)); do
        if docker exec "$INSTANCE" docker --host unix:///var/run/docker.sock info >/dev/null 2>&1; then ready=true; break; fi
        sleep 1
      done
      "$ready" || { printf 'Nested Docker failed to start. Run docker logs %s\n' "$INSTANCE" >&2; exit 1; }
    fi
    copy_source
    inner up
    printf '\nLive mailcow: http://localhost:%s/admin\nTLS: https://localhost:%s/admin (local self-signed certificate)\n' "$HTTP_PORT" "$HTTPS_PORT"
    printf 'Fresh test database login: admin / moohoo\nSource changes: %s sync\n' "$0"
    ;;
  sync) require_running; copy_source; inner sync ;;
  status) require_running; inner status ;;
  logs) require_running; if [[ -n "$SERVICE" ]]; then inner logs "$SERVICE"; else inner logs; fi ;;
  shell) require_running; run docker exec -it "$INSTANCE" /harness/manage.sh shell ;;
  stop) require_running; inner stop; run docker stop --time 60 "$INSTANCE" ;;
  down)
    owned_container
    if "$DRY_RUN" || [[ $(docker inspect -f '{{ .State.Running }}' "$INSTANCE") == true ]]; then
      inner stop
      run docker stop --time 60 "$INSTANCE"
    fi
    run docker rm "$INSTANCE"
    ;;
  reset)
    if ! "$ASSUME_YES" && ! "$DRY_RUN"; then
      printf 'Delete test container %s and volumes %s, %s? [y/N] ' "$INSTANCE" "$DATA_VOLUME" "$WORK_VOLUME"
      read -r answer
      [[ "$answer" == y || "$answer" == Y ]] || exit 0
    fi
    if exists || "$DRY_RUN"; then owned_container; run docker rm --force "$INSTANCE"; fi
    for name in "$DATA_VOLUME" "$WORK_VOLUME"; do
      if "$DRY_RUN"; then run docker volume rm "$name";
      elif docker volume inspect "$name" >/dev/null 2>&1; then
        volume "$name" # verifies ownership before removal
        run docker volume rm "$name"
      fi
    done
    ;;
esac
