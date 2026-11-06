import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_DISPATCHER, DEFAULT_LOCALPART, dispatcherLocalpart, sessionLocalpart } from "./format.ts"
import plugin from "./index.ts"
import { readAsToken } from "./matrix.ts"

// Runs against the local Synapse from ../setup.sh with person "ramiro" (../add-person.sh ramiro). TEST_PERSON and
// TEST_LOCALPART test another person and naming (../add-person.sh <person> --localpart <template>).
const HOMESERVER = "http://localhost:8008"
const ROOT = join(import.meta.dir, "..")
const PERSON = process.env.TEST_PERSON ?? "ramiro"
const identity = { person: PERSON, serverName: "agents.local", localpart: process.env.TEST_LOCALPART ?? DEFAULT_LOCALPART, dispatcher: DEFAULT_DISPATCHER }
const HUMAN = `@${PERSON}:agents.local`
const DISPATCHER = `@${dispatcherLocalpart(identity)}:agents.local`
const REGISTRATION = join(ROOT, `appservices/${PERSON}.yaml`)
const accountOf = (sessionID: string) => `@${sessionLocalpart(identity, sessionID)}:agents.local`
const up = await fetch(`${HOMESERVER}/health`).then((r) => r.ok).catch(() => false)

const run = Date.now().toString(36)
const LEAD = `ses_${run}Lead`
const WORKER = `ses_${run}Worker`
const SPAWNED = `ses_${run}Spawned`
const WORKSPACE = mkdtempSync(join(tmpdir(), "workspace-"))
mkdirSync(join(WORKSPACE, "server/common-infra/.git"), { recursive: true })

function mockCtx() {
  const store = new Map<string, unknown>()
  const sessions = new Map<string, any>([
    [LEAD, { id: LEAD, title: "Lead", metadata: {} }],
    [WORKER, { id: WORKER, title: "Worker", metadata: {} }],
  ])
  const synthetic: any[] = []
  const created: any[] = []
  const prompts: any[] = []
  const calls: any[] = []
  const tools = new Map<string, any>()
  const hooks = new Map<string, (input: any) => unknown>()
  const queue: any[] = []
  let wake = () => {}
  return {
    store,
    sessions,
    synthetic,
    created,
    prompts,
    calls,
    tools,
    emit(event: any) {
      queue.push(event)
      wake()
    },
    /** A model call of the session, sending these messages. */
    context(sessionID: string, messages: unknown[]) {
      return hooks.get("context")!({ sessionID, messages, agent: "build", tools: {}, system: [], options: {} })
    },
    ctx: {
      options: {
        homeserver: HOMESERVER,
        serverName: "agents.local",
        person: PERSON,
        localpart: identity.localpart,
        registration: REGISTRATION,
        workspace: WORKSPACE,
      },
      storage: {
        get: async (key: string) => store.get(key),
        set: async (key: string, value: unknown) => void store.set(key, value),
        remove: async (key: string) => void store.delete(key),
        scan: async ({ prefix }: { prefix: string }) => ({
          entries: [...store].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
        }),
      },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          const session = sessions.get(sessionID)
          if (!session) throw new Error("not found")
          return session
        },
        synthetic: async (input: any) => void synthetic.push(input),
        create: async (input: any) => {
          const session = {
            id: `ses_${run}Started${created.length}`,
            title: input.title,
            agent: input.agent,
            model: input.model,
            metadata: input.metadata,
            location: input.location,
            tokens: { input: 1200, output: 34, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0,
          }
          sessions.set(session.id, session)
          created.push(input)
          return session
        },
        prompt: async (input: any) => void prompts.push(input),
        switchAgent: async (input: any) => void calls.push({ switchAgent: input }),
        switchModel: async (input: any) => void calls.push({ switchModel: input }),
        interrupt: async (input: any) => void calls.push({ interrupt: input }),
        update: async (input: any) => {
          sessions.get(input.sessionID).title = input.title
          queue.push({ type: "session.renamed", data: { sessionID: input.sessionID, title: input.title } })
          wake()
        },
        hook: async (name: string, callback: (input: any) => unknown) => {
          hooks.set(name, callback)
          return { dispose: async () => void hooks.delete(name) }
        },
      },
      agent: {
        list: async () => ({
          data: [
            { id: "build", mode: "primary", hidden: false },
            { id: "plan", mode: "primary", hidden: false },
            { id: "explore", mode: "subagent", hidden: false },
          ],
        }),
      },
      model: {
        list: async () => ({
          data: ["claude-opus-5-5", "claude-sonnet-5-5"].map((id) => ({
            id,
            modelID: id,
            providerID: "anthropic",
            family: id.replace(/-5-5$/, ""),
            enabled: true,
            status: "active",
            variants: [{ id: "high" }],
            time: { released: 1 },
          })),
        }),
      },
      tool: { transform: async (callback: any) => callback({ add: (tool: any) => tools.set(tool.name, tool) }) },
      event: {
        subscribe: ({ signal }: { signal: AbortSignal }) => ({
          async *[Symbol.asyncIterator]() {
            while (!signal.aborted) {
              if (queue.length) yield queue.shift()
              else await new Promise<void>((resolve) => ((wake = resolve), signal.addEventListener("abort", () => resolve())))
            }
          },
        }),
      },
    },
  }
}

const mock = mockCtx()
let stop = async () => {}
const call = (name: string, sessionID: string, input: unknown) => mock.tools.get(name).execute(input, { sessionID })

async function waitFor<T>(check: () => T | undefined, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await Bun.sleep(200)
  }
  throw new Error("timed out")
}
async function waitForAsync<T>(check: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await Bun.sleep(200)
  }
  throw new Error("timed out")
}

/** GET as one of the person's appservice accounts. */
function asAccount(userID: string, path: string, query: Record<string, string> = {}): Promise<any> {
  const token = readAsToken(REGISTRATION)
  const params = new URLSearchParams({ ...query, user_id: userID })
  return fetch(`${HOMESERVER}/_matrix/client/v3${path}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json())
}

const noticeFor = (sessionID: string, text: string) => () =>
  mock.synthetic.find((input) => input.sessionID === sessionID && input.text.includes(text))

beforeAll(async () => {
  if (!up) return
  // Rooms left over from earlier runs would make the dispatcher replay their messages.
  const { human } = await loginHuman()
  const sync = await human("/sync?timeout=0", "GET")
  for (const roomId of [...Object.keys(sync.rooms?.join ?? {}), ...Object.keys(sync.rooms?.invite ?? {})]) {
    await human(`/rooms/${encodeURIComponent(roomId)}/leave`, "POST", {})
  }
  stop = await plugin.setup(mock.ctx)
}, 120_000)
afterAll(() => stop())

test.skipIf(!up)("a lead can message a worker that never used Matrix, and the worker can reply", async () => {
  const sent = JSON.parse((await call("matrix_send", LEAD, { to: WORKER, text: "hello worker" })).content)
  expect(sent.from).toBe(accountOf(LEAD))

  const toWorker = await waitFor(noticeFor(WORKER, "hello worker"))
  expect(toWorker.resume).toBe(true)
  expect(toWorker.text).toContain("another of your user's agent sessions")

  await call("matrix_send", WORKER, { to: LEAD, text: "hello lead" })
  await waitFor(noticeFor(LEAD, "hello lead"))
  // The reply went to the same DM room.
  expect(mock.store.get(`dm:${WORKER}:${sent.from}`)).toBe(sent.room)
}, 60_000)

test.skipIf(!up)("mentioning a session in a team room invites it and notifies it; unmentioned traffic does not", async () => {
  const room = `#poc-${run}`
  await call("matrix_send", LEAD, { to: room, text: "general chatter" })
  await call("matrix_send", LEAD, { to: room, text: "please check the migration", mention: [WORKER] })
  const toWorker = await waitFor(noticeFor(WORKER, "please check the migration"))
  expect(toWorker.text).toContain(`#poc-${run}:agents.local`)
  expect(mock.synthetic.some((input) => input.sessionID === WORKER && input.text.includes("general chatter"))).toBe(false)

  const history = (await call("matrix_read", WORKER, { room })).content
  expect(history).toContain("general chatter")
  expect(history).toContain("please check the migration")
}, 60_000)

test.skipIf(!up)("Threads workers get an account as soon as they are created", async () => {
  mock.sessions.set(SPAWNED, { id: SPAWNED, title: "Spawned worker", metadata: { opThreads: { coordinatorID: LEAD } } })
  mock.emit({ type: "session.created", data: { sessionID: SPAWNED } })
  await waitFor(() => mock.store.get(`account:${SPAWNED}`))
}, 30_000)

/** The human account, logged in once: Synapse rate-limits logins. */
let humanLogin: Promise<{ human: (path: string, method: string, body?: unknown) => Promise<any> }> | undefined
function loginHuman() {
  humanLogin ??= (async () => {
    const password = readFileSync(join(ROOT, `secrets/${PERSON}-password`), "utf8").trim()
    const login: any = await fetch(`${HOMESERVER}/_matrix/client/v3/login`, {
      method: "POST",
      body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user: PERSON }, password }),
    }).then((r) => r.json())
    if (!login.access_token) throw new Error(`login failed: ${JSON.stringify(login)}`)
    const human = (path: string, method: string, body?: unknown) =>
      fetch(`${HOMESERVER}/_matrix/client/v3${path}`, {
        method,
        headers: { Authorization: `Bearer ${login.access_token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then((r) => r.json() as Promise<any>)
    return { human }
  })()
  return humanLogin
}
afterAll(async () => {
  await humanLogin?.then(({ human }) => human("/logout", "POST", {})).catch(() => {})
})

test.skipIf(!up)("the human can reply from their own account and is framed as the user", async () => {
  const sent = JSON.parse((await call("matrix_send", LEAD, { to: "user", text: "need a decision: A or B?" })).content)
  const { human } = await loginHuman()
  await human(`/join/${encodeURIComponent(sent.room)}`, "POST", {})
  await human(`/rooms/${encodeURIComponent(sent.room)}/send/m.room.message/t${run}`, "PUT", { msgtype: "m.text", body: "go with B" })

  const toLead = await waitFor(noticeFor(LEAD, "go with B"))
  expect(toLead.text).toContain(`your user (${PERSON})`)

  // Messages get a read receipt, which the human's client shows, once a model call includes them.
  const goWithB = toLead.metadata.agentMatrix.events.at(-1)
  await mock.context(LEAD, [{ role: "user", content: "unrelated" }])
  await Bun.sleep(1000)
  expect(Object.keys((await readReceipt(human, sent.room, goWithB)) ?? {})).not.toContain(sent.from)
  await mock.context(LEAD, [{ role: "user", content: [{ type: "text", text: toLead.text }] }])
  await waitForAsync(async () => (await readReceipt(human, sent.room, goWithB))?.[sent.from])
}, 60_000)

let syncs = 0
/** Who has read the event, from the human's view of the room. */
async function readReceipt(human: (path: string, method: string) => Promise<any>, room: string, eventId: string) {
  // Synapse caches sync responses for a while; a filter of its own makes each request new.
  const filter = { room: { rooms: [room], timeline: { limit: 1, not_senders: [`@nobody${++syncs}:invalid`] } } }
  const sync = await human(`/sync?timeout=0&filter=${encodeURIComponent(JSON.stringify(filter))}`, "GET")
  const event = sync.rooms?.join?.[room]?.ephemeral?.events?.find((e: any) => e.type === "m.receipt" && e.content[eventId])
  return event?.content[eventId]["m.read"] as Record<string, unknown> | undefined
}

test.skipIf(!up)("a DM to the dispatcher starts a session that gets its own DM with the human", async () => {
  const dispatcher = DISPATCHER
  const { human } = await loginHuman()
  const { room_id: room } = await human("/createRoom", "POST", { preset: "trusted_private_chat", is_direct: true, invite: [dispatcher] })
  await waitForAsync(async () => (await human(`/rooms/${encodeURIComponent(room)}/joined_members`, "GET")).joined?.[dispatcher])
  const order = await human(`/rooms/${encodeURIComponent(room)}/send/m.room.message/d${run}`, "PUT", { msgtype: "m.text", body: `check the backups ${run}` })

  const prompt = await waitFor(() => mock.prompts.find((input) => input.text.includes(`check the backups ${run}`)))
  // The dispatcher marks the message read when the started session's model first runs.
  await Bun.sleep(1000)
  expect(Object.keys((await readReceipt(human, room, order.event_id)) ?? {})).not.toContain(dispatcher)
  await mock.context(prompt.sessionID, [])
  await waitForAsync(async () => (await readReceipt(human, room, order.event_id))?.[dispatcher])
  expect(mock.created.at(-1)).toMatchObject({ location: { directory: WORKSPACE } })
  expect(mock.created.at(-1).title).toBeUndefined()
  const self = (mock.store.get(`account:${prompt.sessionID}`) as { userID: string }).userID
  expect(prompt.text).toContain(`as ${self}`)

  const dm = mock.store.get(`dm:${prompt.sessionID}:${HUMAN}`) as string
  const membership = await asAccount(self, `/rooms/${encodeURIComponent(dm)}/state/m.room.member/${encodeURIComponent(HUMAN)}`)
  expect(membership.membership).toBe("invite")
  const replies = await human(`/rooms/${encodeURIComponent(room)}/messages?dir=b&limit=5`, "GET")
  expect(replies.chunk.some((event: any) => event.sender === dispatcher && event.content?.body?.includes(prompt.sessionID))).toBe(true)

  // A file's caption is the prompt, and the session is told about the file.
  const url = "mxc://agents.local/notfetched"
  await human(`/rooms/${encodeURIComponent(room)}/send/m.room.message/df${run}`, "PUT", { msgtype: "m.file", body: `summarize this ${run}`, filename: "report.pdf", url })
  const withFile = await waitFor(() => mock.prompts.find((input) => input.text.includes(`summarize this ${run}`)))
  expect(withFile.text).toContain(`(file report.pdf: ${url}; matrix_download fetches it)`)
}, 60_000)

test.skipIf(!up)("options pick the agent, model and directory; !commands control the dispatcher and the session", async () => {
  const dispatcher = DISPATCHER
  const { human } = await loginHuman()
  let txn = 0
  const say = (room: string, body: string) =>
    human(`/rooms/${encodeURIComponent(room)}/send/m.room.message/c${run}-${++txn}`, "PUT", { msgtype: "m.text", body })
  const replyIn = (room: string, from: string, text: string) =>
    waitForAsync(async () => {
      const messages = await human(`/rooms/${encodeURIComponent(room)}/messages?dir=b&limit=20`, "GET")
      return messages.chunk?.find((event: any) => event.sender === from && event.content?.body?.includes(text))?.content.body as string
    })

  const { room_id: room } = await human("/createRoom", "POST", { preset: "trusted_private_chat", is_direct: true, invite: [dispatcher] })
  await waitForAsync(async () => (await human(`/rooms/${encodeURIComponent(room)}/joined_members`, "GET")).joined?.[dispatcher])

  await say(room, "dir=nowhere do something")
  expect(await replyIn(room, dispatcher, 'Unknown directory "nowhere"')).toContain("Directories: server, server/common-infra.")
  await say(room, "!help")
  expect(await replyIn(room, dispatcher, "Agents: build, plan")).toContain("Models: opus (claude-opus-5-5), sonnet (claude-sonnet-5-5)")

  await say(room, `agent=plan dir=server/common-infra model=sonnet#high review the config ${run}`)
  const prompt = await waitFor(() => mock.prompts.find((input) => input.text.includes(`review the config ${run}`)))
  expect(prompt.text).not.toContain("agent=plan")
  expect(mock.created.at(-1)).toMatchObject({
    agent: "plan",
    model: { id: "claude-sonnet-5-5", providerID: "anthropic", variant: "high" },
    location: { directory: join(WORKSPACE, "server/common-infra") },
  })
  expect(await replyIn(room, dispatcher, prompt.sessionID)).toContain("(agent plan, model anthropic/claude-sonnet-5-5#high, in server/common-infra)")

  const self = (mock.store.get(`account:${prompt.sessionID}`) as { userID: string }).userID
  const dm = mock.store.get(`dm:${prompt.sessionID}:${HUMAN}`) as string
  // Messages sent before the account's first sync are not delivered.
  await waitFor(() => mock.store.get(`since:${prompt.sessionID}`))
  await human(`/join/${encodeURIComponent(dm)}`, "POST", {})
  await say(dm, "!agent build")
  await replyIn(dm, self, "Switched to agent build.")
  await say(dm, "!model nope")
  expect(await replyIn(dm, self, 'Unknown model "nope"')).toContain("Short names: opus, sonnet.")
  await say(dm, "!status")
  expect(await replyIn(dm, self, "Directory:")).toContain("Tokens: 1,200 in, 34 out")
  await say(dm, "!stop")
  await replyIn(dm, self, "Interrupted.")
  expect(mock.calls).toEqual([{ switchAgent: { sessionID: prompt.sessionID, agent: "build" } }, { interrupt: { sessionID: prompt.sessionID } }])
  expect(mock.synthetic.some((input) => input.sessionID === prompt.sessionID)).toBe(false)

  await say(dm, "!rename Config review")
  await replyIn(dm, self, "Renamed to Config review.")
  await waitForAsync(async () => (await human(`/rooms/${encodeURIComponent(dm)}/state/m.room.name/`, "GET")).name === "Config review")
  await waitForAsync(async () => (await human(`/profile/${encodeURIComponent(self)}/displayname`, "GET")).displayname === "Config review")

  await say(room, "!default agent=plan")
  await replyIn(room, dispatcher, "Defaults for this room: agent=plan")
  await say(room, `plan the upgrade ${run}`)
  await waitFor(() => mock.prompts.find((input) => input.text.includes(`plan the upgrade ${run}`)))
  expect(mock.created.at(-1)).toMatchObject({ agent: "plan", location: { directory: WORKSPACE } })
  await say(room, "!sessions")
  expect(await replyIn(room, dispatcher, "Recent sessions:")).toContain(`${prompt.sessionID} [idle] Config review`)
}, 90_000)

test.skipIf(!up)("a file is uploaded and sent with the text as its caption; files outside the allowed directories are refused", async () => {
  const path = join(WORKSPACE, "dot.png")
  // A 1x1 PNG.
  writeFileSync(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==", "base64"))
  const sent = JSON.parse((await call("matrix_send", LEAD, { to: "user", text: "the plot", file: path })).content)
  const event = await asAccount(sent.from, `/rooms/${encodeURIComponent(sent.room)}/event/${encodeURIComponent(sent.event_id)}`)
  expect(event.content).toMatchObject({ msgtype: "m.image", body: "the plot", filename: "dot.png", info: { mimetype: "image/png", size: 70 } })
  expect(event.content.url).toStartWith("mxc://")

  await expect(call("matrix_send", LEAD, { to: "user", file: "/etc/hostname" })).rejects.toThrow("can be uploaded")
  await expect(call("matrix_send", LEAD, { to: "user" })).rejects.toThrow("Give a text, html or a file")
}, 30_000)

test.skipIf(!up)("files can be uploaded once and sent by mxc:// URI; `as` picks how they are shown", async () => {
  const path = join(WORKSPACE, "notes.txt")
  writeFileSync(path, "hello")
  const event = async (sent: any) =>
    (await asAccount(sent.from, `/rooms/${encodeURIComponent(sent.room)}/event/${encodeURIComponent(sent.event_id)}`)).content
  const uploaded = JSON.parse((await call("matrix_upload", LEAD, { file: `file://${path}` })).content)
  expect(uploaded).toMatchObject({ filename: "notes.txt", mimetype: "text/plain", size: 5, msgtype: "m.file" })
  expect(uploaded.url).toStartWith("mxc://")

  const sent = JSON.parse((await call("matrix_send", LEAD, { to: "user", file: uploaded.url })).content)
  expect(await event(sent)).toMatchObject({ msgtype: "m.file", body: "notes.txt", url: uploaded.url, info: { mimetype: "text/plain", size: 5 } })
  const png = JSON.parse((await call("matrix_send", LEAD, { to: "user", file: { uri: join(WORKSPACE, "dot.png"), as: "file" } })).content)
  expect((await event(png)).msgtype).toBe("m.file")
  await expect(call("matrix_send", LEAD, { to: "user", file: "mxc://elsewhere.org/abc" })).rejects.toThrow("give `file: {uri, as}`")
  const foreign = JSON.parse(
    (await call("matrix_send", LEAD, { to: "user", file: { uri: "mxc://elsewhere.org/abc", as: "image" }, text: "a cat" })).content,
  )
  expect(await event(foreign)).toMatchObject({ msgtype: "m.image", body: "a cat", url: "mxc://elsewhere.org/abc" })
  const stringified = JSON.parse((await call("matrix_send", LEAD, { to: "user", file: JSON.stringify({ uri: uploaded.url, as: "image" }) })).content)
  expect(await event(stringified)).toMatchObject({ msgtype: "m.image", url: uploaded.url })
}, 30_000)

test.skipIf(!up)("sessions see files from the human with their caption and can download them", async () => {
  const path = join(WORKSPACE, `shot-${run}.png`)
  writeFileSync(path, "not really a png")
  const uploaded = JSON.parse((await call("matrix_upload", WORKER, { file: path })).content)
  const sent = JSON.parse((await call("matrix_send", LEAD, { to: "user", text: "send me the screenshot" })).content)
  const { human } = await loginHuman()
  await human(`/join/${encodeURIComponent(sent.room)}`, "POST", {})
  await human(`/rooms/${encodeURIComponent(sent.room)}/send/m.room.message/f${run}`, "PUT", {
    msgtype: "m.image",
    body: `here it is ${run}`,
    filename: `shot-${run}.png`,
    url: uploaded.url,
    info: { mimetype: "image/png", size: 16 },
  })

  const toLead = await waitFor(noticeFor(LEAD, `here it is ${run}`))
  expect(toLead.text).toContain(`(image shot-${run}.png: image/png, 16 B, ${uploaded.url}; matrix_download fetches it)`)
  const downloaded = JSON.parse((await call("matrix_download", LEAD, { uri: uploaded.url })).content)
  expect(downloaded).toMatchObject({ mimetype: "image/png", size: 16 })
  expect(downloaded.path).toEndWith(`/shot-${run}.png`)
  expect(readFileSync(downloaded.path, "utf8")).toBe("not really a png")
  await expect(call("matrix_download", LEAD, { uri: "mxc://agents.local/../x" })).rejects.toThrow("Not an mxc:// URI")
}, 30_000)

test.skipIf(!up)("Markdown is sent as HTML, plain text stays plain, and HTML can be given as is", async () => {
  const content = async (input: Record<string, unknown>) => {
    const sent = JSON.parse((await call("matrix_send", LEAD, { to: "user", ...input })).content)
    return (await asAccount(sent.from, `/rooms/${encodeURIComponent(sent.room)}/event/${encodeURIComponent(sent.event_id)}`)).content
  }
  expect(await content({ text: "**done**" })).toMatchObject({
    body: "**done**",
    format: "org.matrix.custom.html",
    formatted_body: "<p><strong>done</strong></p>",
  })
  expect((await content({ text: "just words" })).format).toBeUndefined()
  expect(await content({ html: "<font color=\"red\">down</font>" })).toMatchObject({ body: "down", formatted_body: '<font color="red">down</font>' })
  const mentioned = await content({ text: "_look_", mention: [WORKER] })
  expect(mentioned.formatted_body).toStartWith(`<p><a href="https://matrix.to/#/${accountOf(WORKER)}">`)
}, 30_000)

test.skipIf(!up)("sessions see event IDs, replies with the quoted message, and edits; they can reply, edit and react", async () => {
  const event = (sent: any) => asAccount(sent.from, `/rooms/${encodeURIComponent(sent.room)}/event/${encodeURIComponent(sent.event_id)}`)
  const question = JSON.parse((await call("matrix_send", LEAD, { to: WORKER, text: `which port ${run}?` })).content)
  await waitFor(noticeFor(WORKER, question.event_id))

  const answer = JSON.parse((await call("matrix_send", WORKER, { to: LEAD, text: `port 8448 ${run}`, reply_to: question.event_id })).content)
  expect((await event(answer)).content).toMatchObject({
    "m.relates_to": { "m.in_reply_to": { event_id: question.event_id } },
    "m.mentions": { user_ids: [question.from] },
  })
  const reply = await waitFor(noticeFor(LEAD, `port 8448 ${run}`))
  expect(reply.text).toContain(`(in reply to ${question.event_id}, ${question.from}: "which port ${run}?")`)

  const edit = JSON.parse((await call("matrix_send", WORKER, { to: LEAD, text: `port 8449 ${run}`, edit: answer.event_id })).content)
  expect((await event(edit)).content).toMatchObject({
    body: `* port 8449 ${run}`,
    "m.new_content": { body: `port 8449 ${run}` },
    "m.relates_to": { rel_type: "m.replace", event_id: answer.event_id },
  })
  expect((await waitFor(noticeFor(LEAD, `port 8449 ${run}`))).text).toContain(`(edit of ${answer.event_id})\n  port 8449 ${run}`)
  await expect(call("matrix_send", LEAD, { to: WORKER, text: "mine now", edit: answer.event_id })).rejects.toThrow("Only your own messages")
  await expect(call("matrix_send", LEAD, { to: "user", text: "x", reply_to: question.event_id })).rejects.toThrow("No event")

  const reaction = JSON.parse((await call("matrix_react", LEAD, { room: WORKER, event: answer.event_id, key: "✅" })).content)
  expect((await event(reaction)).content).toEqual({ "m.relates_to": { rel_type: "m.annotation", event_id: answer.event_id, key: "✅" } })

  // A reaction to a session's own message reaches it (waking it); reactions to other messages do not.
  const reacted = await waitFor(noticeFor(WORKER, `reacted ✅ to your message ${answer.event_id}: "port 8448 ${run}"`))
  expect(reacted).toMatchObject({ resume: true, description: "Matrix: 1 new reaction" })
  await call("matrix_react", WORKER, { room: LEAD, event: question.event_id, key: "👀" })
  await call("matrix_react", WORKER, { room: LEAD, event: answer.event_id, key: "✅" })
  await waitFor(noticeFor(LEAD, `reacted 👀 to your message ${question.event_id}`))
  expect(mock.synthetic.some((input) => input.sessionID === LEAD && input.text.includes(`to your message ${answer.event_id}`))).toBe(false)

  const history = (await call("matrix_read", LEAD, { room: WORKER, limit: 5 })).content
  expect(history).toContain(`port 8448 ${run}\n  (reactions: ✅ you, ${answer.from})`)
  expect(history).toContain(`which port ${run}?\n  (reactions: 👀 ${answer.from})`)
}, 60_000)

test.skipIf(!up)("matrix_api calls the client API as the session; matrix_openapi describes endpoints", async () => {
  const sent = JSON.parse((await call("matrix_send", LEAD, { to: "user", text: "topic soon" })).content)
  const room = encodeURIComponent(sent.room)
  const api = async (input: unknown) => JSON.parse((await call("matrix_api", LEAD, input)).content)
  const put = await api({ method: "PUT", path: `/_matrix/client/v3/rooms/${room}/state/m.room.topic/`, body: { topic: `t ${run}` } })
  expect(put).toMatchObject({ as: sent.from, status: 200 })
  const get = await api({ method: "GET", path: `/_matrix/client/v3/rooms/${room}/state/m.room.topic/`, query: { user_id: DISPATCHER } })
  expect(get).toMatchObject({ status: 200, body: { topic: `t ${run}` } })
  // A body sent as a JSON string is sent as the object it encodes.
  const stringBody = await api({ method: "PUT", path: `/_matrix/client/v3/rooms/${room}/state/m.room.topic/`, body: JSON.stringify({ topic: `s ${run}` }) })
  expect(stringBody.status).toBe(200)
  await expect(call("matrix_api", LEAD, { method: "PUT", path: `/_matrix/client/v3/rooms/${room}/state/m.room.topic/`, body: "{nope" })).rejects.toThrow("JSON object")
  expect((await api({ method: "GET", path: "/_matrix/client/v3/account/whoami" })).body.user_id).toBe(sent.from)
  expect((await api({ method: "GET", path: `/_matrix/client/v3/rooms/${room}/event/%24nope` })).status).toBe(404)
  await expect(call("matrix_api", LEAD, { method: "POST", path: "/_matrix/client/v3/register" })).rejects.toThrow("not allowed")
  await expect(call("matrix_api", LEAD, { method: "GET", path: "/_matrix/client/v3/../../_synapse/admin/v1/users" })).rejects.toThrow()

  const redact = (await call("matrix_openapi", LEAD, { path: `/_matrix/client/v3/rooms/${room}/redact/%24e/1` })).content
  expect(JSON.parse(redact)).toMatchObject({ endpoint: "PUT /_matrix/client/v3/rooms/{roomId}/redact/{eventId}/{txnId}" })
  expect((await call("matrix_openapi", LEAD, { search: "redact" })).content).toContain("PUT /_matrix/client/v3/rooms/{roomId}/redact/")
  expect((await call("matrix_openapi", LEAD, {})).content).toContain("Room participation")
}, 60_000)

test.skipIf(!up)("a failed session tells the human in their DM", async () => {
  const sent = JSON.parse((await call("matrix_send", WORKER, { to: "user", text: "working on it" })).content)
  mock.emit({ type: "session.execution.failed", data: { sessionID: WORKER, error: { type: "provider.quota", message: "quota exceeded" } } })
  await waitForAsync(async () => {
    const messages = await asAccount(sent.from, `/rooms/${encodeURIComponent(sent.room)}/messages`, { dir: "b", limit: "5" })
    return messages.chunk?.some((event: any) => event.content?.body === "This session stopped with an error: quota exceeded")
  })
}, 30_000)

test.skipIf(!up)("the dispatcher declines invites from anyone but its person", async () => {
  const sent = JSON.parse((await call("matrix_send", LEAD, { to: `@${dispatcherLocalpart(identity)}`, text: "start something" })).content)
  const lead = sent.from as string
  const members = async () =>
    Object.keys((await asAccount(lead, `/rooms/${encodeURIComponent(sent.room)}/joined_members`)).joined ?? {})
  // The invite is resolved (declined) once the dispatcher is no longer pending in the room.
  await waitForAsync(async () => {
    const state = await asAccount(lead, `/rooms/${encodeURIComponent(sent.room)}/state/m.room.member/${encodeURIComponent(DISPATCHER)}`)
    return state.membership === "leave"
  })
  expect(await members()).not.toContain(DISPATCHER)
  expect(mock.prompts.some((input) => input.text.includes("start something"))).toBe(false)
}, 30_000)
