#!/usr/bin/env bash
# Builds the app and deploys it to the Azure Web App from an admin workstation
# (same package as .github/workflows/deploy.yml). Useful for the first rollout
# before GitHub Actions is connected to Azure.
#
# Usage:  scripts/deploy-local.sh <resource-group> <web-app-name>
#         (both values: `terraform -chdir=infra/terraform output -raw resource_group_name` / `web_app_name`)
# Needs:  Node.js 22, npm, zip, Azure CLI logged in (`az login`) with rights on the web app.
set -euo pipefail

RG="${1:?usage: $0 <resource-group> <web-app-name>}"
APP="${2:?usage: $0 <resource-group> <web-app-name>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$ROOT"
echo "==> Installing dependencies and building"
npm ci --no-audit --no-fund
npm run typecheck
npm run build

echo "==> Assembling package"
mkdir -p "$WORK/staging"
cp -r dist package.json package-lock.json "$WORK/staging/"
(cd "$WORK/staging" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
test -f "$WORK/staging/dist/server.mjs" && test -f "$WORK/staging/dist/public/index.html"
(cd "$WORK/staging" && zip -qr "$WORK/deploy.zip" dist node_modules package.json package-lock.json)
echo "    package: $(du -h "$WORK/deploy.zip" | cut -f1)"

echo "==> Deploying to $APP ($RG)"
az webapp deploy --resource-group "$RG" --name "$APP" --src-path "$WORK/deploy.zip" --type zip --async false

URL="https://$(az webapp show -g "$RG" -n "$APP" --query defaultHostName -o tsv)"
echo "==> Waiting for $URL/healthz"
for i in $(seq 1 30); do
  if curl -fsS "$URL/healthz" >/dev/null 2>&1 && curl -fsS "$URL/readyz" >/dev/null 2>&1; then
    echo "    OK – app and database are reachable: $URL"
    exit 0
  fi
  sleep 10
done
echo "!! The app did not become ready. Check: az webapp log tail -g $RG -n $APP" >&2
exit 1
