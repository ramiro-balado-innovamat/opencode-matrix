# opencode-matrix

The `agent-matrix` OpenCode plugin: one Matrix account per OpenCode session, plus a dispatcher account that starts
a new session for every message from its person. The plugin is in `opencode-plugin/` (see its README); `README.md`
and the root scripts are the local Synapse used to develop it.

## Usage

DM the dispatcher, `@<person>.agent:<server>` by default (or mention it in a room it is in). Each message starts a session; the
session's own account invites you to a DM, which is the conversation from then on. The dispatcher declines invites
from anyone but `@<person>`. If a session fails (e.g. the model provider rejects the request), it posts the error in
that DM.

```
agent=plan dir=web/api model=sonnet#high why is the login test flaky?   # options first, then the prompt
!help                         # agents, directories, models
!sessions                     # recent sessions with links to their DMs
!default dir=web/api          # this room's defaults (!default clear)
```

In a session's DM: `!status`, `!agent <agent>`, `!model <model>[#variant]`, `!rename <name>`, `!stop`, `!help`. Anything else goes
to the session.

## Tests

`cd opencode-plugin && bun install && bun test` after `./setup.sh && ./add-person.sh ramiro` (local Synapse on :8008).

CI (the `opencode-matrix` Concourse pipeline, `task update-pipeline`) runs `ci/test.sh` on every push: it starts a
throwaway Synapse inside the `matrixdotorg/synapse` image, sets up `ramiro` as `add-person.sh` would, and runs the
same tests. A second task runs them as `ramiro.balado` with `localpart` `{person}+{name}` in a non-exclusive
namespace (`TEST_PERSON`, `TEST_LOCALPART`, `TEST_EXCLUSIVE`). To run one locally:
`docker run --rm --entrypoint /src/ci/test.sh -v <copy of the repo>:/src -w /src matrixdotorg/synapse`. `synapse-overrides.yaml` and `scripts/appservice-registration.sh` are shared with `setup.sh` and
`add-person.sh`.
