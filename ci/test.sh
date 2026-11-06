#!/usr/bin/env bash
# Runs the plugin's tests against a throwaway Synapse, inside the matrixdotorg/synapse image (Concourse can't run
# Docker, so this replaces setup.sh and add-person.sh). Run from the repository root.
#
# TEST_PERSON, TEST_LOCALPART and TEST_EXCLUSIVE choose the person and how their agent accounts are named (the
# plugin's `localpart` option); the defaults are the plugin's.
set -euo pipefail

BUN_VERSION=1.3.14
SERVER_NAME=agents.local
export TEST_PERSON="${TEST_PERSON:-ramiro}"
DEFAULT_LOCALPART='{person}.{name}'
export TEST_LOCALPART="${TEST_LOCALPART:-$DEFAULT_LOCALPART}"
NAME="$TEST_PERSON"

mkdir -p data appservices secrets
# UID is read-only in bash, hence env.
env SYNAPSE_SERVER_NAME=$SERVER_NAME SYNAPSE_REPORT_STATS=no SYNAPSE_CONFIG_DIR="$PWD/data" SYNAPSE_DATA_DIR="$PWD/data" \
  UID=0 GID=0 /start.py generate
scripts/appservice-registration.sh "$NAME" "$SERVER_NAME" "$TEST_LOCALPART" "${TEST_EXCLUSIVE:-true}" > "appservices/$NAME.yaml"
{ echo; cat synapse-overrides.yaml; echo "app_service_config_files: [$PWD/appservices/$NAME.yaml]"; } >> data/homeserver.yaml
# The generated config logs to a file next to it; stderr is more useful in a build log.
sed -i 's#^log_config:.*##' data/homeserver.yaml

python -m synapse.app.homeserver -c data/homeserver.yaml > synapse.log 2>&1 &
trap 'kill %1 2>/dev/null || true' EXIT
if ! scripts/wait-for-synapse.sh; then
  tail -50 synapse.log
  exit 1
fi
PASSWORD="$(python -c 'import secrets; print(secrets.token_urlsafe(18))')"
register_new_matrix_user -c data/homeserver.yaml -u "$NAME" -p "$PASSWORD" -a http://localhost:8008
echo "$PASSWORD" > "secrets/$NAME-password"

curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-x64.zip"
python -c 'import zipfile; zipfile.ZipFile("/tmp/bun.zip").extractall("/tmp")'
BUN=/tmp/bun-linux-x64/bun
chmod +x "$BUN"

cd opencode-plugin
"$BUN" install
"$BUN" test
