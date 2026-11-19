#!/usr/bin/env bash
# Compatibility entry point; upgrade.sh now owns the complete deployment transaction.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
exec bash "$ROOT/upgrade.sh" "$@"
