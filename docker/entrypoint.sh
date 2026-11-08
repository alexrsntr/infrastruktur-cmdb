#!/bin/sh
# Container entrypoint: creates the secrets the app needs on the first start and keeps them in
# the /data volume, so nobody has to generate them by hand. Values set via environment win.
set -eu

DATA_DIR="${DATA_DIR:-/data}"

# load_secret <variable> <file name>
load_secret() {
  eval "current=\${$1:-}"
  if [ -n "$current" ]; then return 0; fi
  file="$DATA_DIR/$2"
  if [ ! -s "$file" ]; then
    if [ ! -w "$DATA_DIR" ]; then
      echo "cmdb-entrypoint: $DATA_DIR is not writable – set $1 or mount a volume at $DATA_DIR" >&2
      exit 1
    fi
    (umask 077 && head -c 48 /dev/urandom | base64 | tr -d '\n' > "$file")
    echo "cmdb-entrypoint: generated $1 (stored in $file)"
  fi
  value="$(cat "$file")"
  export "$1=$value"
}

load_secret SESSION_SECRET session-secret
load_secret SETTINGS_ENCRYPTION_KEY settings-encryption-key

exec "$@"
