# opencode-matrix

OpenCode sessions on Matrix, with **one Matrix account per agent session**. The OpenCode plugin is in
`opencode-plugin/`.

This README covers the local development stack the plugin is tested against.

- Synapse (SQLite, federation unused, registration closed) on `http://localhost:8008`
- Element Web on `http://localhost:8080`, so humans can watch and join
- Server name `agents.local`

## Identity model

Each person gets:

- a **human account** `@<name>:agents.local`, for Element;
- an **appservice** that exclusively owns the namespace `@<name>.*:agents.local`.
  Its `as_token` can create and act as any account in that namespace, and nothing
  outside it. Agent sessions are accounts like `@ramiro.ses_abc123:agents.local`.

`./add-person.sh <name> --localpart '{person}+{name}'` names the namespace like the plugin's `localpart` option
(`@<name>+*`), and `--not-exclusive` lets other accounts be created in it too.

The token is sent as a bearer token, with `?user_id=` set to the session's account
to choose which session account is acting. The appservice has `url: null`: the
homeserver pushes nothing, and each session reads its own messages with `/sync`.

## Usage

```bash
./setup.sh                          # first run generates data/homeserver.yaml, then starts the stack
./add-person.sh ramiro              # human account + session namespace (restarts Synapse)
python3 scripts/smoke_test.py ramiro
```

The smoke test creates two session accounts, has them share a room (with the human
invited), sends a structured message from A and checks that B receives it with a
long-poll `/sync`, and that the token is refused outside its namespace.

Log into Element as `@ramiro:agents.local` with the password in `secrets/ramiro-password`.

```bash
docker compose down                 # stop
rm -rf data appservices secrets     # reset everything
```

## Files

| Path | Contents | In git |
|---|---|---|
| `data/` | Synapse config, signing key, SQLite database | no |
| `appservices/<name>.yaml` | appservice registration incl. `as_token` | no |
| `secrets/<name>-password` | human account password | no |

## License

[GPL-3.0-or-later](LICENSE).
