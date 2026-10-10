#!/usr/bin/env bash
# Runs ON a fresh Ubuntu 24.04 machine (as root) to build the runner image. build-snapshot.sh copies it there and runs it.
# Installs Docker, Node 24, pnpm, the Claude Code CLI and the hcloud CLI, clones the repo, installs dependencies, bakes in
# the Docker images of the test stack, and leaves NO secrets behind.
#   inputs (environment): REPO_SSH_URL, BASE_BRANCH, and the deploy key at /root/.ssh/sdd_deploy (removed at the end)
#   WITH_WEB=1 also installs Playwright's Chromium and pulls the dev stack images (for the front-end specs)
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
: "${REPO_SSH_URL:?}" "${BASE_BRANCH:=master}"

echo "== packages"
apt-get update -y
apt-get install -y ca-certificates curl git jq tmux unzip build-essential python3 python3-pip openssl xz-utils

echo "== docker"
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

echo "== node 24, pnpm, claude code, hcloud"
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1)" != v24 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
npm install -g pnpm@12.5.1 @anthropic-ai/claude-code
curl -fsSL https://github.com/hetznercloud/cli/releases/latest/download/hcloud-linux-amd64.tar.gz | tar -xz -C /usr/local/bin hcloud

echo "== kernel settings Elasticsearch and Scylla need"
cat > /etc/sysctl.d/99-sdd.conf <<'S'
vm.max_map_count=262144
fs.aio-max-nr=1048576
S
sysctl --system >/dev/null

echo "== repo"
mkdir -p /opt/sdd /etc/sdd /var/log/sdd /root/.ssh
chmod 700 /root/.ssh
ssh-keyscan -t ed25519,rsa github.com >> /root/.ssh/known_hosts 2>/dev/null
cat > /root/.ssh/config <<'S'
Host github.com
  IdentityFile /root/.ssh/sdd_deploy
  IdentitiesOnly yes
S
chmod 600 /root/.ssh/config
if [[ ! -d /opt/sdd/repo/.git ]]; then git clone "$REPO_SSH_URL" /opt/sdd/repo; fi
cd /opt/sdd/repo
git fetch origin
git checkout -B "$BASE_BRANCH" "origin/$BASE_BRANCH"

echo "== dependencies and the files git does not carry"
pnpm install --frozen-lockfile
cp -n packages/backend/env/test.env.example packages/backend/.env.test
mkdir -p packages/backend/creds
openssl genrsa -out packages/backend/creds/jwtRS256.key 2048 2>/dev/null
openssl rsa -in packages/backend/creds/jwtRS256.key -pubout -out packages/backend/creds/jwtRS256.key.pub 2>/dev/null

echo "== bake in the test stack images"
docker compose -f docker-compose.test.yaml -p marketplace_test pull --ignore-buildable
docker compose -f docker-compose.test.yaml -p marketplace_test build

if [[ "${WITH_WEB:-}" == 1 ]]; then
  echo "== front-end: Playwright browser and dev stack images"
  (cd packages/web && pnpm exec playwright install --with-deps chromium) || echo "WARN: playwright install failed (no Playwright in packages/web yet?)"
  bash scripts/infra/make-dev-env.sh
  docker compose --env-file packages/backend/.env pull --ignore-buildable
  docker compose --env-file packages/backend/.env build db
fi

echo "== clean up (no secrets stay in the image)"
rm -f /root/.ssh/sdd_deploy /root/.ssh/sdd_deploy.pub
apt-get clean
rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache
history -c || true
echo "bootstrap finished"
