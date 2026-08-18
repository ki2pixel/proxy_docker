#!/usr/bin/env bash
# Alias vers scripts/start.sh
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$DIR/start.sh" "$@"
