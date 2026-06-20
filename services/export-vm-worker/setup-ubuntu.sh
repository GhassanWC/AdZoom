#!/usr/bin/env bash
#
# Framevo export VM worker — one-shot Ubuntu setup.
#
# Run on a fresh GCE VM (Ubuntu 22.04 LTS) whose ATTACHED service account has
# datastore.user + storage.objectAdmin on the bucket + artifactregistry.reader.
# Installs Docker, authenticates it to Artifact Registry (via the VM's SA),
# stages the compose + env, and installs the systemd unit.
#
#   bash setup-ubuntu.sh
#
set -euo pipefail

REPO_DIR="/opt/framevo/export-vm-worker"
REGISTRY_HOST="us-central1-docker.pkg.dev"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[setup] installing Docker (if missing)…"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
sudo systemctl enable --now docker

echo "[setup] authenticating Docker to Artifact Registry ($REGISTRY_HOST) via the VM service account…"
# Configure for root, since the systemd unit + pulls run as root.
sudo gcloud auth configure-docker "$REGISTRY_HOST" --quiet

echo "[setup] staging compose + env into $REPO_DIR…"
sudo mkdir -p "$REPO_DIR"
sudo cp "$HERE/docker-compose.yml" "$REPO_DIR/"
if [ ! -f "$REPO_DIR/.env" ]; then
  sudo cp "$HERE/.env.example" "$REPO_DIR/.env"
  echo "[setup] wrote $REPO_DIR/.env from .env.example — review it before going live."
fi

echo "[setup] pulling the worker image…"
sudo docker compose -f "$REPO_DIR/docker-compose.yml" --env-file "$REPO_DIR/.env" pull

echo "[setup] installing + starting the systemd unit…"
sudo cp "$HERE/framevo-export-worker.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now framevo-export-worker.service

echo
echo "[setup] done. Verify startup with:"
echo "  sudo docker logs --tail=50 framevo-export-worker     # expect [vm-worker:startup] mode=firestore-poll runWorker=True"
echo "  curl -s localhost:8080/health                         # expect: ok"
echo "  sudo journalctl -u framevo-export-worker -f           # systemd-level logs"
