#!/usr/bin/env bash
# Alias vers scripts/status.sh
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$DIR/status.sh" "$@"
