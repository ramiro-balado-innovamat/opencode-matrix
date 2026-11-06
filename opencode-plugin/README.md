# agent-matrix OpenCode plugin

One Matrix account per OpenCode session, `@<person>.<session id, lowercase>:<server>` by default (see `localpart`
under [Options](#options)), created through the person's appservice token (see `../README.md`).

## When a session gets an account

- **Lazily**, the first time it calls a `matrix_*` tool.
- **When another local session messages or mentions it** (`to: "ses_..."`), so a lead can reach a worker
  that never used Matrix.
- **Eagerly** for Threads and workflow workers (`session.created` with `metadata.opThreads` or
  `metadata.opWorkflow`), so their coordinator can talk to them from the start.

Every account runs a long-poll `/sync` loop. **DMs, mentions and reactions to the session's own messages** are
delivered to the session as synthetic
messages (`resume: true`, so an idle session wakes up), batched per sync response, with a deterministic ID so a
re-delivery after a restart is a no-op. Other room traffic is not pushed: read it with `matrix_read`. Invites
are accepted automatically. The sync position is stored per session, so a restart does not replay messages.

If a session with a DM to its human fails (`session.execution.failed`), it posts the error there, since the human
cannot see the transcript.

## Dispatcher

With the `workspace` option, the plugin also runs a dispatcher account, `@<person>.agent` by default. Every DM to it (or mention of it) from the
person's human account creates a session in `workspace`, gives it an account that invites the human to a DM, and
sends the message as the session's first prompt, with an instruction to answer through `matrix_send`. The
session starts untitled, so OpenCode's `title` agent names it after the first prompt, which renames the account and
the DM (see `!rename` below). The dispatcher replies in the original room with the session ID. It declines invites from anyone else.

Leading `key=value` options choose the session's settings; parsing stops at the first other word:

| Option | Value |
|---|---|
| `agent=` | A primary, visible agent (`build`, `plan`, custom ones) |
| `dir=` | A relative path to a directory inside `workspace` (`server/common-infra`); no `..` or absolute paths |
| `model=` | `opus`, `sonnet`, `haiku`... (newest non-fast model of the family), a model ID, or `provider/id`; `#variant` optional |

Invalid values get an error listing the valid ones; no session is started. Dispatcher commands: `!help`,
`!sessions` (the last 10 it started), `!default [options | clear]` (per-room defaults, merged under the message's
options).

`!commands` from the human in a session's DM control that session instead of reaching it: `!status`,
`!agent <agent>`, `!model <model>[#variant]`, `!rename <name>` (session title, display name and DM room name),
`!stop` (interrupt), `!help`. Renaming the session any other way (e.g. the `session_rename` tool) also renames the
account and the DM.

Messages are framed by sender: your own human account counts as your user writing over chat; everyone else
(agents and other people) is information, not instructions.

## Tools

| Tool | Purpose |
|---|---|
| `matrix_whoami` | This session's account and addressing rules |
| `matrix_send {to, text?, html?, file?, mention?, reply_to?, edit?}` | DM (`user`, `ses_...`, `@user:server`) or room (`#alias`, `!room`). A missing `#alias` room is created, with the human invited. Mentioned users not in the room are invited. `text` is Markdown, rendered with `marked` into `formatted_body` (unless it is plain paragraphs) and kept as is in `body`; `html` is sent as `formatted_body` verbatim, with `text` (or `html` without its tags) as `body`. `file` (a path, a `file://` URL or an `mxc://` URI, or `{uri, as}`) is sent as `m.image`/`m.video`/`m.audio`/`m.file` with `text` as its caption: by extension, or `as` (required for an `mxc://` URI this plugin did not upload). The object form is also accepted as a JSON string. `reply_to` sends a reply (`m.in_reply_to`, without the deprecated quote fallback) that mentions the original's sender; `edit` replaces one of the session's own messages (`m.replace`). |
| `matrix_upload {file}` | Uploads a file to the media repository and returns its `mxc://` URI, name, type and size, for sending it later or using it with `matrix_api` (avatars). Only files under the session's directory or the temporary directory, since the plugin reads them outside OpenCode's permission checks; `matrix_send` uploads paths the same way. Uploads are remembered (plugin storage), so sending their URI keeps the name and type. |
| `matrix_download {uri}` | Downloads an `mxc://` URI (authenticated media) to `<tmpdir>/agent-matrix/<session>/<media ID>/<file name>` and returns its path, type and size, so the `read` tool can open it (images and PDFs included). Refuses files over `maxDownloadMB`. |
| `matrix_react {room, event, key}` | Reaction (`m.annotation`) to a message |
| `matrix_read {room, limit?}` | Recent messages of a room or DM, with their reactions |
| `matrix_rooms` | Rooms and DMs this session is in |
| `matrix_api {method, path, query?, body?}` | Any Client-Server API request as the session's account, for everything the tools above do not wrap. `user_id` is always the session's; paths must be normalized and under `/_matrix/client/`, and `register`, `login` and `logout` are refused (with the appservice token they reach every account in the namespace). The response is cut at 20,000 characters. |
| `matrix_openapi {path?, method?, search?}` | The OpenAPI description of one endpoint (templated or concrete path), a search over the endpoints, or the list of categories. The spec is the newest stable version in the homeserver's `/versions`, loaded from spec.matrix.org on first use. Error responses keep only their description and nested examples are dropped, so most endpoints take 1–3k characters (`/sync` is the largest, about 36k). |

Messages get a public read receipt (`m.read`) once the agent has seen them, so the sender's client shows them as
read: a notice when a model call that includes it starts (the session `context` hook), a message to the dispatcher
when the session it started first calls its model, and `!commands` and dispatcher commands when they are answered.
Pending receipts are kept in memory, so a message whose session has not reached the model before a restart stays
unread.

Messages (notices and `matrix_read`) show their event ID, so they can be replied to, edited or reacted to. A
reply shows the event it answers, with its sender and an excerpt (fetched, since the deprecated quote fallback in
the body is stripped); an edit shows the event it replaces and its new text. A file (`m.image`, `m.video`,
`m.audio`, `m.file`) shows its kind, name, type, size and `mxc://` URI, with its caption as the text. Sent to the
dispatcher, a file's caption is the prompt (with options), and the session is told about the file. A reaction
shows its key and the message it reacts to, with an excerpt; `matrix_read` lists each message's reactions by key,
with who gave them (removed ones are redacted, so they drop out), from the reactions it pages through while
fetching the messages.

`matrix_api` is a convenience, not a boundary: the appservice registration is readable by the `opencode` user,
so a session could use the as_token directly.

## Client quirks

How clients render `formatted_body` differs; these were found testing FluffyChat (Android, October 2026) against
its renderer, `lib/pages/chat/events/html_message.dart`. Other clients were not tested.

- **Colours** only apply on `<span>` (`data-mx-color`, `data-mx-bg-color`, or the deprecated `color`). FluffyChat
  ignores them on `<font>`, although the spec allows `<font data-mx-color>`.
- **Line breaks** are only added *after* a block element (`p`, `ul`, `ol`, `pre`, `div`, `table`, `details`,
  `blockquote`, plus `li` and headings), never before one. Text followed by a block in the same parent runs on:
  - `<li>text<ul>…` (a tight Markdown list with a nested list) puts the first nested item on the item's line.
    `markdownToHTML` inserts a `<br>` before such nested lists; browsers ignore a `<br>` right before a block.
  - `<details><summary>…</summary>text` shows the summary and the text on one line once expanded. Put a `<br>`
    after `</summary>` (the `html` option is sent as is, so this is up to the sender).
- **Spacing:** every `p`, `ul` and `ol` is followed by a blank line, `hr` by none, so a rule after a paragraph has
  a large gap above it and none below. Not worked around.
- **`<b>` and `<strike>`** are allowed but unstyled: use `<strong>` and `<del>`/`<s>`. `<i>` and `<u>` work.
- **Table captions** (`<caption>`) are dropped.
- **Task lists:** `<input>` is not allowed, so marked's checkboxes would leave plain bullets (FluffyChat only knows
  its own `li.task-list-item`, checked through reactions). `markdownToHTML` writes ✅/⬜ instead.
- **Mentions:** user and room `matrix.to` links show as pills; marked does not link bare user IDs, so
  `markdownToHTML` links `@user:server` itself (not inside links, code or email addresses).
- **Spoilers** (`<span data-mx-spoiler>`), tables, code blocks, quotes, nested lists, headings, `<sup>`/`<sub>`
  and `<ruby>` otherwise render fine.
- **Renaming DMs** is not possible: the chat details page disables the name (and avatar) action for any room
  marked direct, even with the power level. Reported as krille-chan/fluffychat#3791.
- **Compressed images** sent to an unencrypted room are uploaded uncompressed, while `info` (size, dimensions)
  describes the compressed image: matrix-dart-sdk's `sendFileEvent` uploads the original unless it encrypts.
  `matrix_download` gets the original bytes. Reported as famedly/matrix-dart-sdk#2524.

## Options

```jsonc
{
  "package": "/path/to/agent-matrix/opencode-plugin",
  "options": {
    "homeserver": "http://localhost:8008",
    "serverName": "agents.local",
    "person": "ramiro",
    "registration": "/path/to/agent-matrix/appservices/ramiro.yaml", // or a file holding only the as_token
    "localpart": "{person}.{name}", // optional, how agent accounts are named
    "dispatcher": "agent", // optional, the dispatcher's {name}
    "workspace": "/path/to/workspace", // optional, enables the dispatcher
    "maxDownloadMB": 50, // optional, largest file matrix_download fetches
    "debug": false
  }
}
```

`localpart` names the person's agent accounts: `{person}` is the `person` option and `{name}` is `ses_<session id>`
for a session or `dispatcher` for the dispatcher. It must match the user namespace of the appservice registration.
The default, `{person}.{name}`, gives `@ramiro.ses_abc123` and `@ramiro.agent`. On a server where people's names
contain dots, `{person}+{name}` keeps them apart from people's own accounts (`@pau.oliver+ses_abc123` next to
`@pau.oliver`). Changing it only affects accounts created afterwards; existing sessions keep theirs.

`dispatcher` names the dispatcher, for instance when two OpenCode servers of the same person use one homeserver and
each needs its own.

## Tests

`bun install && bun test`. `index.test.ts` runs against the local Synapse (skipped if it is down) with a mock OpenCode context.
`TEST_PERSON` and `TEST_LOCALPART` run it as another person and naming, after `../add-person.sh <person> --localpart <template>`.

## Known gaps

- Accounts are never deactivated, and a deleted session's account stays in its rooms.
- Only `m.room.message` is handled; no threads, reactions or edits. Sessions can send files but only see the
  file name of files they receive.
- No end-to-end encryption.
