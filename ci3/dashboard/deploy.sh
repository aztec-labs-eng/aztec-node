#!/bin/bash
# Deploy the CI dashboard (rkapp + Caddy TLS) to the ci host.
#
# Safe to run repeatedly. The first run also performs the one-time cutover from the
# legacy systemd `rkapp` unit (which bound :80 directly) to the compose stack (rkapp on
# loopback, Caddy terminating TLS on 443 and redirecting 80). Nothing running is touched
# until the compose config parses and the image builds; if the new stack is not healthy
# after the cutover, it is torn down and the legacy unit is restarted on its previous image.
#
# Prerequisite: /etc/rkapp.env (root, mode 600) on the host — the app secrets. Compose
# reads env_file client-side, so every compose command runs under sudo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST=${1:-ubuntu@ci.aztec-labs.com}
KEY=~/.ssh/build_instance_key

rsync -avz --exclude='deploy.sh' -e "ssh -i $KEY" "$SCRIPT_DIR"/ "$HOST":rk

ssh -i "$KEY" "$HOST" '
  set -euo pipefail
  if ! sudo test -f /etc/rkapp.env; then
    echo "ERROR: /etc/rkapp.env missing. Create it (root, mode 600) before deploying." >&2
    exit 1
  fi
  mkdir -p /home/ubuntu/rk/caddy/data /home/ubuntu/rk/caddy/config
  cd rk
  compose() { sudo docker compose "$@"; }

  compose config -q

  legacy=0
  if systemctl is-active --quiet rkapp || systemctl is-enabled --quiet rkapp 2>/dev/null; then
    legacy=1
    # The build retags rkapp, which the legacy unit also runs; keep its image for rollback.
    docker tag rkapp rkapp:legacy
  fi

  compose build

  if [ "$legacy" = 1 ]; then
    echo "Retiring legacy systemd rkapp unit..."
    sudo systemctl disable --now rkapp
  fi

  # 200, or 401 when the dashboard password is set.
  up() {
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$@" || true)
    [ "$code" = 200 ] || [ "$code" = 401 ]
  }

  healthy=0
  if compose up -d; then
    # Caddy obtains its certificate on first boot, so https can lag the app.
    for _ in $(seq 60); do
      if up http://127.0.0.1:8080/ &&
         up --resolve ci.aztec-labs.com:443:127.0.0.1 https://ci.aztec-labs.com/; then
        healthy=1
        break
      fi
      sleep 2
    done
  fi

  if [ "$healthy" = 0 ]; then
    echo "ERROR: dashboard not healthy on loopback and via Caddy https." >&2
    compose logs --tail=30 >&2 || true
    if [ "$legacy" = 1 ]; then
      echo "Rolling back to the legacy systemd rkapp unit..." >&2
      compose down || true
      docker tag rkapp:legacy rkapp || true
      sudo systemctl enable --now rkapp
    fi
    exit 1
  fi
  docker rmi rkapp:legacy >/dev/null 2>&1 || true
  echo "Dashboard up behind Caddy: https://ci.aztec-labs.com"
'
