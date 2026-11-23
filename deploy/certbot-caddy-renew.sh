#!/bin/sh
set -eu

[ "${RENEWED_LINEAGE:-}" = "/etc/letsencrypt/live/api.whyweloose.pw" ] || exit 0

cert_dir="/var/lib/docker/volumes/whyweloose_caddy/_data/certs/api"
install -d -o root -g root -m 0755 "$cert_dir"
install -o root -g root -m 0644 "$RENEWED_LINEAGE/fullchain.pem" "$cert_dir/fullchain.pem"
install -o root -g root -m 0600 "$RENEWED_LINEAGE/privkey.pem" "$cert_dir/privkey.pem"
docker exec whyweloose-web-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
