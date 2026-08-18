#!/usr/bin/env bash
# Alias vers scripts/test_proxy.sh
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$DIR/test_proxy.sh" "$@"
