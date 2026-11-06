#!/usr/bin/env bash
# Prints a person's appservice registration: it owns the person's agent accounts, named after the plugin's
# `localpart` template (default {person}.{name}, so @<name>.*), and may create room aliases.
set -euo pipefail
USAGE="usage: appservice-registration.sh <name> <server name> [localpart template] [exclusive: true|false]"
NAME="${1:?$USAGE}"
SERVER_NAME="${2:?$USAGE}"
DEFAULT_LOCALPART='{person}.{name}'
LOCALPART="${3:-$DEFAULT_LOCALPART}"
EXCLUSIVE="${4:-true}"

# The template with {person} filled in and {name} matching anything, as a regex.
USERS_REGEX="$(python3 - "$LOCALPART" "$NAME" "$SERVER_NAME" <<'EOF'
import re, sys
template, name, server = sys.argv[1:]
pattern = re.escape(template).replace(re.escape("{person}"), re.escape(name)).replace(re.escape("{name}"), ".+")
print(f"@{pattern}:{re.escape(server)}")
EOF
)"

cat <<EOF
id: $NAME-sessions
url: null
as_token: $(python3 -c "import secrets; print(secrets.token_hex(32))")
hs_token: $(python3 -c "import secrets; print(secrets.token_hex(32))")
sender_localpart: $NAME-sessions
rate_limited: false
namespaces:
  users:
    - regex: '$USERS_REGEX'
      exclusive: $EXCLUSIVE
  # Sessions may create team room aliases (#bki-1234); shared by every person, so not exclusive.
  aliases:
    - regex: "#.*:$SERVER_NAME"
      exclusive: false
  rooms: []
EOF
