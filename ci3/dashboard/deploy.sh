#!/bin/bash
# Deploy the CI dashboard (rkapp + Caddy TLS) to the ci host.
#
# Safe to run repeatedly. The first run also performs the one-time cutover from the
# legacy systemd `rkapp` unit (which bound :80 directly) to the compose stack (rkapp on
# loopback, Caddy terminating TLS on 443 and redirecting 80). Ordering is chosen so a
# failure leaves the current service up: the new image is built BEFORE the old unit is
# retired.
#
# Prerequisite: /etc/rkapp.env (mode 600) on the host — the app secrets. deploy.sh
# refuses to proceed without it rather than bring the app up unconfigured.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST=${1:-ubuntu@ci.aztec-labs.com}
KEY=~/.ssh/build_instance_key

rsync -avz --exclude='deploy.sh' -e "ssh -i $KEY" "$SCRIPT_DIR"/ "$HOST":rk

ssh -i "$KEY" "$HOST" '
  set -euo pipefail
  if [ ! -f /etc/rkapp.env ]; then
    echo "ERROR: /etc/rkapp.env missing. Create it (mode 600) before deploying." >&2
    exit 1
  fi
  mkdir -p /home/ubuntu/rk/caddy/data /home/ubuntu/rk/caddy/config
  cd rk

  # Build the new image first — nothing running is disturbed if this fails.
  docker compose build

  # Retire the legacy systemd rkapp so Caddy can bind 80/443. Idempotent: a no-op
  # once it is already gone, so steady-state redeploys skip it.
  if systemctl list-unit-files rkapp.service >/dev/null 2>&1; then
    echo "Retiring legacy systemd rkapp unit..."
    sudo systemctl disable --now rkapp 2>/dev/null || true
  fi

  docker compose up -d

  # Liveness: the app answers on loopback (401 = up-and-auth-gated, which is fine;
  # 000 = not listening). Caddy issues its cert on first boot, so https may lag a few
  # seconds — check it in a browser.
  sleep 3
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/ || echo 000)
  if [ "$code" = "000" ]; then
    echo "ERROR: app not responding on 127.0.0.1:8080" >&2
    docker compose logs --tail=30 rkapp >&2
    exit 1
  fi
  echo "Dashboard app up (http $code on loopback). Caddy fronting 443; verify https in a browser."
'
