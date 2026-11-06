import {
  attachmentType,
  checkLocalpart,
  DEFAULT_DISPATCHER,
  DEFAULT_LOCALPART,
  describeAttachment,
  describeCount,
  describeSender,
  dispatcherLocalpart,
  excerpt,
  formatMessage,
  htmlToText,
  humanID,
  markdownToHTML,
  mentions,
  messageAttachment,
  messageText,
  notice,
  noticeID,
  parseTarget,
  sessionLocalpart,
  startedFromMatrix,
  TRUST_NOTE,
  type Attachment,
  type Identity,
  type ReceivedMessage,
  type Target,
} from "./format.ts"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, relative, resolve as resolvePath, sep } from "node:path"
import { fileURLToPath } from "node:url"
import {
  dispatcherHelp,
  formatModel,
  modelAliases,
  parseCommand,
  parseOptions,
  resolveDir,
  resolveModel,
  selectableAgents,
  SESSION_HELP,
  workspaceDirs,
  type Command,
  type ModelInfo,
  type ModelRef,
  type StartOptions,
} from "./commands.ts"
import { checkClientPath, Matrix, MatrixError, readAsToken } from "./matrix.ts"
import { categories, describeOperation, findOperations, listLine, MAX_RESULTS, operations, searchOperations, specURL, type Operation } from "./openapi.ts"

// One Matrix account per OpenCode session, created through the person's appservice token. An account is
// created the first time a session uses a matrix_* tool, when another session messages it, or right away
// for Threads/workflow workers so their coordinator can reach them. Each account runs a /sync loop that
// delivers DMs and mentions to its session as synthetic messages. With `workspace` set, a dispatcher
// account (@<person>.agent by default) starts a new session for every DM or mention it gets from the person.

export interface AgentMatrixOptions {
  homeserver: string
  serverName: string
  /** Owner of this OpenCode server: their own account is @<person>. */
  person: string
  /**
   * How the person's agent accounts are named, with `{person}` and `{name}` (`ses_<id>` for a session, `dispatcher` for
   * the dispatcher). Default `{person}.{name}`: @ramiro.ses_abc123 and @ramiro.agent. It must match the appservice's
   * user namespace.
   */
  localpart?: string
  /** The dispatcher's `{name}` in `localpart`. Default `agent`. */
  dispatcher?: string
  /** Appservice registration file holding the person's as_token, or a file holding only the token. */
  registration: string
  /** Directory for sessions started through the dispatcher; the dispatcher is disabled without it. */
  workspace?: string
  /** Largest file matrix_download fetches, in MB. Default 50. */
  maxDownloadMB?: number
  debug?: boolean
}

/** The dispatcher's key in loops and storage, whatever its account is called. */
const DISPATCHER = "agent"
const SYNC_TIMEOUT_MS = 30_000
const RETRY_MS = 5_000
const MAX_API_CHARS = 20_000
const DEFAULT_MAX_DOWNLOAD_MB = 50
const SYNC_FILTER = {
  presence: { not_types: ["*"] },
  account_data: { not_types: ["*"] },
  room: {
    timeline: { limit: 50, types: ["m.room.message", "m.reaction"] },
    state: { lazy_load_members: true },
    ephemeral: { not_types: ["*"] },
    account_data: { not_types: ["*"] },
  },
}

// Plugin instances (one per location) share one server process: keep a single sync loop per session.
interface SharedState {
  ctxs: Set<any>
  loops: Map<string, AbortController>
  ensuring: Map<string, Promise<string>>
  /** Sessions currently executing, from session.execution.* events. */
  running: Set<string>
  /** Read receipts sent once a model call of the session includes the message (any message, without `eventId`). */
  unread: Map<string, PendingReceipt[]>
}
interface PendingReceipt {
  userID: string
  roomId: string
  receipt: string
  /** Event ID to look for in the session's messages; without it, the session's next model call counts. */
  eventId?: string
}
const STATE_KEY = Symbol.for("agent-matrix.state")
function shared(): SharedState {
  const state = ((globalThis as any)[STATE_KEY] ??= { ctxs: new Set(), loops: new Map(), ensuring: new Map(), running: new Set() })
  state.unread ??= new Map()
  return state
}

/** Removes a leading mention ("Name: ..." or "@user:server: ...") that clients put before the text. */
function stripMention(body: string, prefixes: readonly string[]) {
  for (const prefix of prefixes) {
    if (body.startsWith(prefix)) return body.slice(prefix.length).replace(/^[:,]?\s*/, "")
  }
  return body
}

function parseJSONBody(text: string) {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error("`body` must be a JSON object")
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true })
  })
}

export async function setupAgentMatrix(ctx: any): Promise<() => Promise<void>> {
  const options = ctx.options as AgentMatrixOptions
  for (const key of ["homeserver", "serverName", "person", "registration"] as const) {
    if (!options?.[key]) throw new Error(`agent-matrix: missing option "${key}"`)
  }
  const identity: Identity = {
    person: options.person,
    serverName: options.serverName,
    localpart: options.localpart ?? DEFAULT_LOCALPART,
    dispatcher: options.dispatcher ?? DEFAULT_DISPATCHER,
  }
  checkLocalpart(identity.localpart)
  const matrix = new Matrix({ homeserver: options.homeserver, serverName: options.serverName, asToken: readAsToken(options.registration) })
  const state = shared()
  state.ctxs.add(ctx)

  const log = (...args: unknown[]) => {
    if (options.debug) console.error("[agent-matrix]", ...args)
  }
  // Any live instance can deliver; the one that started a loop may have unloaded since.
  const live = () => {
    const first = state.ctxs.values().next().value
    if (!first) throw new Error("agent-matrix: no live plugin instance")
    return first
  }
  const storage = () => live().storage

  const names = new Map<string, string | undefined>()
  async function senderName(as: string, user: string) {
    if (!names.has(user)) names.set(user, await matrix.displayName(as, user))
    return names.get(user)
  }
  const labels = new Map<string, string>()
  async function roomLabel(as: string, roomId: string) {
    if (!labels.has(roomId)) {
      const alias = (await matrix.roomState(as, roomId, "m.room.canonical_alias"))?.alias
      const name = (await matrix.roomState(as, roomId, "m.room.name"))?.name
      labels.set(roomId, alias ?? name ?? roomId)
    }
    return labels.get(roomId)!
  }

  async function sessionTitle(sessionID: string): Promise<string | undefined> {
    try {
      return (await live().session.get({ sessionID }))?.title
    } catch {
      return undefined
    }
  }
  const displayName = (sessionID: string, title?: string) => (title || sessionID).slice(0, 100)

  /** Creates the session's account if needed and makes sure its sync loop runs. Returns its user ID. */
  async function ensure(sessionID: string): Promise<string> {
    let pending = state.ensuring.get(sessionID)
    if (!pending) {
      pending = (async () => {
        const existing = (await storage().get(`account:${sessionID}`)) as { userID: string } | undefined
        if (existing) return existing.userID
        const userID = await matrix.register(sessionLocalpart(identity, sessionID))
        await matrix.setDisplayName(userID, displayName(sessionID, await sessionTitle(sessionID)))
        await storage().set(`account:${sessionID}`, { userID })
        log("registered", sessionID, userID)
        return userID
      })()
      state.ensuring.set(sessionID, pending)
      pending.catch(() => state.ensuring.delete(sessionID))
    }
    const userID = await pending
    startLoop(sessionID, userID)
    return userID
  }

  type SyncHandler = (response: any, initial: boolean) => Promise<void>

  function startLoop(sessionID: string, userID: string) {
    startSyncLoop(sessionID, userID, async (response, initial) => {
      await acceptInvites(sessionID, userID, response)
      // The first sync of a fresh account only establishes a position; nothing before it is announced.
      if (initial) return
      const { received, commands } = await collect(sessionID, userID, response)
      if (received.length) await deliver(sessionID, userID, received)
      for (const { roomId, eventId, command } of commands) {
        await markRead(userID, roomId, eventId)
        await sessionCommand(sessionID, userID, roomId, command)
      }
    })
  }

  /** `key` is a session ID, or DISPATCHER for the dispatcher account. */
  function startSyncLoop(key: string, userID: string, handle: SyncHandler) {
    if (state.loops.has(key)) return
    const controller = new AbortController()
    state.loops.set(key, controller)
    void runLoop(key, userID, handle, controller.signal).finally(() => {
      if (state.loops.get(key) === controller) state.loops.delete(key)
    })
  }

  async function runLoop(key: string, userID: string, handle: SyncHandler, signal: AbortSignal) {
    let since = (await storage().get(`since:${key}`)) as string | undefined
    while (!signal.aborted) {
      try {
        const response = await matrix.sync(userID, since, since ? SYNC_TIMEOUT_MS : 0, SYNC_FILTER, signal)
        await handle(response, !since)
        since = response.next_batch as string
        await storage().set(`since:${key}`, since)
      } catch (error) {
        if (signal.aborted) break
        log("sync error", key, error)
        await sleep(RETRY_MS, signal)
      }
    }
  }

  async function acceptInvites(sessionID: string, userID: string, response: any, from?: string) {
    for (const [roomId, room] of Object.entries<any>(response.rooms?.invite ?? {})) {
      const own = (room.invite_state?.events ?? []).find((event: any) => event.type === "m.room.member" && event.state_key === userID)
      // One invite that cannot be answered (e.g. everyone else left the room) must not stall the sync loop.
      try {
        if (from && own?.sender !== from) {
          await matrix.leave(userID, roomId)
          log("declined", userID, roomId, own?.sender)
          continue
        }
        await matrix.join(userID, roomId)
        if (own?.content?.is_direct) await rememberDM(sessionID, own.sender, roomId)
        log("joined", userID, roomId, own?.sender)
      } catch (error) {
        log("invite failed", userID, roomId, error)
        await matrix.leave(userID, roomId).catch(() => {})
      }
    }
  }

  async function rememberDM(sessionID: string, other: string, roomId: string) {
    await storage().set(`dm:${sessionID}:${other}`, roomId)
    await storage().set(`dmroom:${sessionID}:${roomId}`, other)
  }

  async function toReceived(userID: string, roomId: string, event: any, dmWith?: string): Promise<ReceivedMessage> {
    const relation = event.content?.["m.relates_to"]
    const replyTo = relation?.["m.in_reply_to"]?.event_id
    let inReplyTo: ReceivedMessage["inReplyTo"]
    if (typeof replyTo === "string") {
      const original = await matrix.event(userID, roomId, replyTo).catch(() => undefined)
      inReplyTo = { eventId: replyTo, sender: original?.sender, excerpt: original ? eventExcerpt(original) : undefined }
    }
    return {
      roomId,
      roomLabel: dmWith ? `DM with ${dmWith}` : await roomLabel(userID, roomId),
      eventId: event.event_id,
      sender: event.sender,
      senderName: await senderName(userID, event.sender),
      body: messageText(event.content),
      time: event.origin_server_ts ?? Date.now(),
      inReplyTo,
      replaces: relation?.rel_type === "m.replace" ? relation.event_id : undefined,
      attachment: messageAttachment(event.content),
    }
  }

  function eventExcerpt(event: any) {
    const file = messageAttachment(event.content)
    return excerpt(messageText(event.content) || (file ? `[${file.kind} ${file.name}]` : ""))
  }

  /** A reaction to one of the session's own messages, as a received message; undefined for any other reaction. */
  async function toReaction(userID: string, roomId: string, event: any, dmWith?: string): Promise<ReceivedMessage | undefined> {
    const relation = event.content?.["m.relates_to"]
    if (relation?.rel_type !== "m.annotation" || typeof relation.key !== "string" || typeof relation.event_id !== "string") return undefined
    const original = await matrix.event(userID, roomId, relation.event_id).catch(() => undefined)
    if (original?.sender !== userID) return undefined
    return {
      roomId,
      roomLabel: dmWith ? `DM with ${dmWith}` : await roomLabel(userID, roomId),
      eventId: event.event_id,
      sender: event.sender,
      senderName: await senderName(userID, event.sender),
      body: "",
      time: event.origin_server_ts ?? Date.now(),
      reaction: { key: relation.key, to: relation.event_id, excerpt: eventExcerpt(original) },
    }
  }

  /**
   * DMs, mentions and reactions to the session's messages are announced; other room traffic is read on demand with
   * matrix_read. `!commands` from the human in their DM with the session control the session instead of reaching it.
   */
  async function collect(sessionID: string, userID: string, response: any) {
    const received: ReceivedMessage[] = []
    const commands: { roomId: string; eventId: string; command: Command }[] = []
    for (const [roomId, room] of Object.entries<any>(response.rooms?.join ?? {})) {
      const dmWith = (await storage().get(`dmroom:${sessionID}:${roomId}`)) as string | undefined
      for (const event of room.timeline?.events ?? []) {
        if (event.sender === userID) continue
        if (event.type === "m.reaction") {
          const reaction = await toReaction(userID, roomId, event, dmWith)
          if (reaction) received.push(reaction)
          continue
        }
        if (event.type !== "m.room.message") continue
        if (!dmWith && !mentions(event, userID)) continue
        const command = dmWith === humanID(identity) && !messageAttachment(event.content) ? parseCommand(String(event.content?.body ?? "")) : undefined
        if (command) commands.push({ roomId, eventId: event.event_id, command })
        else received.push(await toReceived(userID, roomId, event, dmWith))
      }
    }
    return { received, commands }
  }

  const listAgents = async (directory: string) => selectableAgents((await live().agent.list({ location: { directory } })).data)
  const listModels = async (directory: string): Promise<ModelInfo[]> => (await live().model.list({ location: { directory } })).data

  async function sessionCommand(sessionID: string, self: string, roomId: string, { name, args }: Command) {
    const reply = (body: string) => matrix.send(self, roomId, { msgtype: "m.notice", body })
    try {
      const session = await localSession(sessionID)
      if (!session) return void (await reply("This session no longer exists."))
      const directory = session.location.directory
      if (name === "help") await reply(SESSION_HELP)
      else if (name === "status") await reply(sessionStatus(session))
      else if (name === "stop") {
        await live().session.interrupt({ sessionID })
        await reply("Interrupted.")
      } else if (name === "agent") {
        const agents = await listAgents(directory)
        if (!agents.includes(args)) return void (await reply(`Unknown agent "${args}". Agents: ${agents.join(", ")}.`))
        await live().session.switchAgent({ sessionID, agent: args })
        await reply(`Switched to agent ${args}.`)
      } else if (name === "model") {
        const model = resolveModel(args, await listModels(directory))
        if (typeof model === "string") return void (await reply(model))
        await live().session.switchModel({ sessionID, model })
        await reply(`Switched to ${formatModel(model)}.`)
      } else if (name === "rename") {
        if (!args) return void (await reply("Usage: !rename <name>"))
        // The session.renamed event updates the display name and this room's name.
        await live().session.update({ sessionID, title: args })
        await reply(`Renamed to ${args}.`)
      } else await reply(`Unknown command !${name}.\n\n${SESSION_HELP}`)
    } catch (error) {
      log("command failed", sessionID, name, error)
      await reply(`!${name} failed: ${error instanceof Error ? error.message : String(error)}`).catch(() => {})
    }
  }

  function sessionStatus(session: any) {
    const tokens = session.tokens
    const lines = [
      `${session.id}: ${session.title ?? "(untitled)"}`,
      `State: ${state.running.has(session.id) ? "running" : (session.outcome ?? "idle")}`,
      `Agent: ${session.agent ?? "default"}`,
      `Model: ${formatModel(session.model)}`,
      `Directory: ${session.location.directory}`,
    ]
    if (tokens) {
      const n = (value: number) => value.toLocaleString("en-US")
      lines.push(`Tokens: ${n(tokens.input)} in, ${n(tokens.output)} out, cache ${n(tokens.cache.read)} read / ${n(tokens.cache.write)} written`)
    }
    if (session.cost > 0) lines.push(`Cost: $${session.cost.toFixed(2)}`)
    return lines.join("\n")
  }

  async function deliver(sessionID: string, userID: string, received: ReceivedMessage[]) {
    const last = received[received.length - 1]
    await live().session.synthetic({
      sessionID,
      id: noticeID(sessionID, last.eventId),
      text: notice(identity, userID, received),
      description: `Matrix: ${describeCount(received)}`,
      delivery: "steer",
      metadata: { agentMatrix: { events: received.map((message) => message.eventId) } },
      resume: true,
    })
    log("delivered", sessionID, received.length)
    const lastPerRoom = new Map(received.map((message) => [message.roomId, message.eventId]))
    for (const [roomId, eventId] of lastPerRoom) markReadWhenSeen(sessionID, { userID, roomId, receipt: eventId, eventId })
  }

  /** Read receipt for a message that was handled (or reached the model); failing to send one is harmless. */
  async function markRead(userID: string, roomId: string, eventId: string) {
    await matrix.receipt(userID, roomId, eventId).catch((error) => log("receipt failed", userID, roomId, error))
  }

  /**
   * Defers a receipt until the session's model sees the message (see the context hook). Kept in memory only: a
   * restart in between loses it, and the message stays unread in the client.
   */
  function markReadWhenSeen(sessionID: string, pending: PendingReceipt) {
    const list = state.unread.get(sessionID) ?? []
    state.unread.set(sessionID, [...list.filter((other) => other.userID !== pending.userID || other.roomId !== pending.roomId), pending])
  }

  /** Sends the receipts of messages that this model call of the session includes. */
  function sendSeenReceipts(sessionID: string, messages: unknown) {
    const list = state.unread.get(sessionID)
    if (!list?.length) return
    const text = list.some((pending) => pending.eventId) ? JSON.stringify(messages) : ""
    const seen = list.filter((pending) => !pending.eventId || text.includes(pending.eventId))
    if (!seen.length) return
    const rest = list.filter((pending) => !seen.includes(pending))
    if (rest.length) state.unread.set(sessionID, rest)
    else state.unread.delete(sessionID)
    for (const { userID, roomId, receipt } of seen) void markRead(userID, roomId, receipt)
  }

  async function localSession(sessionID: string) {
    try {
      return await live().session.get({ sessionID })
    } catch {
      return undefined
    }
  }

  async function dmRoom(sessionID: string, self: string, other: string) {
    const known = (await storage().get(`dm:${sessionID}:${other}`)) as string | undefined
    if (known) return known
    const roomId = await matrix.createRoom(self, { preset: "trusted_private_chat", is_direct: true, invite: [other] })
    await rememberDM(sessionID, other, roomId)
    return roomId
  }

  async function room(self: string, target: Extract<Target, { kind: "room" }>) {
    if (!target.alias) return matrix.join(self, target.room)
    const existing = await matrix.resolveAlias(self, target.alias)
    if (existing) return matrix.join(self, existing)
    const [localpart, server] = target.alias.slice(1).split(":")
    if (server !== identity.serverName) throw new Error(`Room ${target.alias} does not exist`)
    // Team rooms are open to everyone on the (private) homeserver; the human is invited to watch.
    return matrix.createRoom(self, { room_alias_name: localpart, name: localpart, preset: "public_chat", invite: [humanID(identity)] })
  }

  /** Resolves a `to` value to a room this session is in, creating the DM or room if needed. */
  async function resolve(sessionID: string, self: string, to: string) {
    const target = parseTarget(identity, to)
    if (target.kind === "room") return room(self, target)
    if (target.userID === self) throw new Error("That is this session's own account")
    // A local session gets its account (and sync loop) now, so it can be messaged before it ever used Matrix.
    if (target.sessionID && (await localSession(target.sessionID))) await ensure(target.sessionID)
    try {
      return await dmRoom(sessionID, self, target.userID)
    } catch (error) {
      if (error instanceof MatrixError) throw new Error(`Could not open a DM with ${target.userID} (has it registered on Matrix?): ${error.message}`)
      throw error
    }
  }

  /** The dispatcher only takes orders from the person: their invites are accepted, everyone else's declined. */
  async function startDispatcher(workspace: string) {
    if (state.loops.has(DISPATCHER)) return
    const human = humanID(identity)
    const userID = await matrix.register(dispatcherLocalpart(identity))
    const name = "New session"
    await matrix.setDisplayName(userID, name)
    startSyncLoop(DISPATCHER, userID, async (response, initial) => {
      await acceptInvites(DISPATCHER, userID, response, human)
      if (initial) return
      for (const [roomId, room] of Object.entries<any>(response.rooms?.join ?? {})) {
        const direct = await storage().get(`dmroom:${DISPATCHER}:${roomId}`)
        for (const event of room.timeline?.events ?? []) {
          if (event.type !== "m.room.message" || event.sender !== human) continue
          if (!direct && !mentions(event, userID)) continue
          if (await storage().get(`started:${event.event_id}`)) continue
          await storage().set(`started:${event.event_id}`, true)
          const attachment = messageAttachment(event.content)
          const body = attachment ? messageText(event.content) : String(event.content?.body ?? "")
          const text = stripMention(body.trim(), [userID, name])
          // A started session marks the message read when its model first runs; anything else is handled here.
          const started = await dispatch(workspace, userID, roomId, event.event_id, text, attachment).catch(async (error) => {
            await notifyFailure(userID, roomId, "Could not start a session", error)
            return false
          })
          if (!started) await markRead(userID, roomId, event.event_id)
        }
      }
    })
  }

  /** Answers a command, or starts a session for the prompt. Returns whether a session was started. */
  async function dispatch(workspace: string, dispatcher: string, roomId: string, eventId: string, text: string, attachment?: Attachment) {
    const reply = async (body: string) => (await matrix.send(dispatcher, roomId, { msgtype: "m.notice", body }), false)
    const command = attachment ? undefined : parseCommand(text)
    if (command?.name === "help") return reply(await dispatcherHelpText(workspace))
    if (command?.name === "sessions") return reply(await recentSessions())
    if (command?.name === "default") return reply(await roomDefaults(workspace, roomId, command.args))
    if (command) return reply(`Unknown command !${command.name}.\n\n${await dispatcherHelpText(workspace)}`)

    const { options, rest } = parseOptions(text)
    if (!rest) {
      const where = attachment ? "as the file's caption" : "after the options"
      return reply(`Nothing to do: add a prompt ${where}. Send !help for usage.`)
    }
    const defaults = ((await storage().get(`defaults:${roomId}`)) ?? {}) as StartOptions
    const settings = await startSettings(workspace, { ...defaults, ...options })
    if (typeof settings === "string") return reply(settings)
    await startSession(workspace, dispatcher, roomId, eventId, attachment ? `${rest}\n\n${describeAttachment(attachment)}` : rest, settings)
    return true
  }

  interface StartSettings {
    directory: string
    agent?: string
    model?: ModelRef
  }

  /** Validates options against the agents, models and workspace directories. Returns an error message on failure. */
  async function startSettings(workspace: string, options: StartOptions): Promise<StartSettings | string> {
    const dir = resolveDir(workspace, options.dir)
    if (typeof dir === "string") return dir
    const settings: StartSettings = { directory: dir.directory }
    if (options.agent) {
      const agents = await listAgents(dir.directory)
      if (!agents.includes(options.agent)) return `Unknown agent "${options.agent}". Agents: ${agents.join(", ")}.`
      settings.agent = options.agent
    }
    if (options.model) {
      const model = resolveModel(options.model, await listModels(dir.directory))
      if (typeof model === "string") return model
      settings.model = model
    }
    return settings
  }

  async function startSession(workspace: string, dispatcher: string, roomId: string, eventId: string, text: string, settings: StartSettings) {
    // No title: OpenCode's title agent names the session after its first prompt, and the session.renamed event
    // renames the account and the DM.
    const session = await live().session.create({
      location: { directory: settings.directory },
      ...(settings.agent ? { agent: settings.agent } : {}),
      ...(settings.model ? { model: settings.model } : {}),
      metadata: { agentMatrix: { room: roomId, event: eventId } },
    })
    const self = await ensure(session.id)
    const dm = await dmRoom(session.id, self, humanID(identity))
    await storage().set(`dispatched:${session.id}`, { created: Date.now(), room: dm })
    const agent = session.agent ?? settings.agent ?? "default"
    const model = session.model ?? settings.model
    const where = relative(workspace, settings.directory) || "the workspace root"
    await matrix.send(dispatcher, roomId, {
      msgtype: "m.text",
      body: `Started ${session.id} (agent ${agent}, model ${model ? formatModel(model) : "the agent's default"}, in ${where}). ${self} has invited you to a DM for it.`,
    })
    log("started", session.id, self)
    markReadWhenSeen(session.id, { userID: dispatcher, roomId, receipt: eventId })
    void live()
      .session.prompt({ sessionID: session.id, text: startedFromMatrix(identity, self, text) })
      .catch(async (error: unknown) => {
        state.unread.delete(session.id)
        await markRead(dispatcher, roomId, eventId)
        await notifyFailure(dispatcher, roomId, `Could not prompt ${session.id}`, error)
      })
  }

  async function dispatcherHelpText(workspace: string) {
    const [agents, models] = await Promise.all([listAgents(workspace), listModels(workspace)])
    return dispatcherHelp(agents, workspaceDirs(workspace), modelAliases(models))
  }

  async function recentSessions() {
    const entries: { key: string; value: any }[] = []
    let after: string | undefined
    do {
      const page = await storage().scan({ prefix: "dispatched:", after, limit: 200 })
      entries.push(...page.entries)
      after = page.next
    } while (after)
    const lines: string[] = []
    for (const entry of entries.sort((a, b) => b.value.created - a.value.created).slice(0, 10)) {
      const session = await localSession(entry.key.slice("dispatched:".length))
      if (!session) continue
      const status = state.running.has(session.id) ? "running" : (session.outcome ?? "idle")
      lines.push(`${session.id} [${status}] ${session.title ?? ""}\n  https://matrix.to/#/${entry.value.room}`)
    }
    return lines.length ? `Recent sessions:\n${lines.join("\n")}` : "No sessions yet."
  }

  async function roomDefaults(workspace: string, roomId: string, args: string) {
    const key = `defaults:${roomId}`
    const current = ((await storage().get(key)) ?? {}) as StartOptions
    const describe = (options: StartOptions) =>
      Object.entries(options)
        .map(([name, value]) => `${name}=${value}`)
        .join(" ")
    if (!args) return Object.keys(current).length ? `Defaults for this room: ${describe(current)}` : "No defaults for this room."
    if (args === "clear") {
      await storage().remove(key)
      return "Cleared this room's defaults."
    }
    const { options, rest } = parseOptions(args)
    if (rest) return `Not an option: "${rest}". Use agent=, dir= and model=, or !default clear.`
    const merged = { ...current, ...options }
    const settings = await startSettings(workspace, merged)
    if (typeof settings === "string") return settings
    await storage().set(key, merged)
    return `Defaults for this room: ${describe(merged)}`
  }

  async function notifyFailure(dispatcher: string, roomId: string, what: string, error: unknown) {
    log(what, error)
    const body = `${what}: ${error instanceof Error ? error.message : String(error)}`
    await matrix.send(dispatcher, roomId, { msgtype: "m.notice", body }).catch((sendError) => log("notify failed", sendError))
  }

  const userIDs = (values: readonly string[] = []) =>
    values.map((value) => {
      const target = parseTarget(identity, value)
      if (target.kind !== "user") throw new Error(`${value} is not a user`)
      return target.userID
    })

  interface Upload {
    url: string
    filename: string
    mimetype: string
    size: number
    msgtype: string
  }

  /**
   * Uploads a file (a path or a file:// URL; relative paths are against the session's directory). The tool reads
   * files itself, outside OpenCode's permission checks, so only files under the session's directory or the
   * temporary directory can be uploaded. Uploads are remembered, so their mxc:// URI can be sent later.
   */
  async function upload(sessionID: string, self: string, file: string): Promise<Upload> {
    const directory = (await localSession(sessionID))?.location?.directory ?? process.cwd()
    const fullPath = await realpath(resolvePath(directory, file.startsWith("file://") ? fileURLToPath(file) : file))
    const allowed = await Promise.all([directory, tmpdir()].map((root) => realpath(root).catch(() => root)))
    if (!allowed.some((root) => fullPath.startsWith(root + sep))) {
      throw new Error(`Only files under ${directory} or ${tmpdir()} can be uploaded`)
    }
    const data = await readFile(fullPath)
    const filename = basename(fullPath)
    const { mimetype, msgtype } = attachmentType(filename)
    const url = await matrix.upload(self, data, filename, mimetype)
    const uploaded = { url, filename, mimetype, size: data.byteLength, msgtype }
    await storage().set(`upload:${url}`, uploaded)
    return uploaded
  }

  /** Message content for a file: uploaded now, or an mxc:// URI (described by its upload, or by `as`). */
  async function attachment(sessionID: string, self: string, file: string, as?: string) {
    const msgtype = as ? `m.${as}` : undefined
    if (file.startsWith("mxc://")) {
      const known = (await storage().get(`upload:${file}`)) as Upload | undefined
      if (!known && !msgtype) throw new Error("This mxc:// URI was not uploaded by this server: give `file: {uri, as}`")
      if (!known) return { msgtype: msgtype!, url: file }
      return { msgtype: msgtype ?? known.msgtype, filename: known.filename, url: file, info: { mimetype: known.mimetype, size: known.size } }
    }
    const uploaded = await upload(sessionID, self, file)
    return { msgtype: msgtype ?? uploaded.msgtype, filename: uploaded.filename, url: uploaded.url, info: { mimetype: uploaded.mimetype, size: uploaded.size } }
  }

  /** Downloads an mxc:// URI to <tmpdir>/agent-matrix/<session>/<media ID>/<file name>, where the read tool can open it. */
  async function download(sessionID: string, self: string, uri: string) {
    const maxBytes = (options.maxDownloadMB ?? DEFAULT_MAX_DOWNLOAD_MB) * 1024 * 1024
    const { mediaId, data, mimetype, filename } = await matrix.download(self, uri, maxBytes)
    const known = (await storage().get(`upload:${uri}`)) as Upload | undefined
    const name = basename(filename ?? known?.filename ?? "")
    const directory = join(tmpdir(), "agent-matrix", sessionID, mediaId)
    await mkdir(directory, { recursive: true })
    const path = join(directory, name && name !== "." && name !== ".." ? name : mediaId)
    await writeFile(path, data)
    return { path, mimetype, size: data.byteLength }
  }

  /** An event of the room, with an error that names the room when the event is not in it. */
  async function roomEvent(self: string, roomId: string, eventId: string, to: string) {
    try {
      return await matrix.event(self, roomId, eventId)
    } catch (error) {
      if (error instanceof MatrixError && error.status === 404) throw new Error(`No event ${eventId} in ${to} (${roomId})`)
      throw error
    }
  }

  async function send(
    sessionID: string,
    input: { to: string; text?: string; html?: string; file?: string | { uri: string; as?: string }; mention?: string[]; reply_to?: string; edit?: string },
  ) {
    // Models sometimes send the object form as a JSON string.
    const given = typeof input.file === "string" && input.file.startsWith("{") ? JSON.parse(input.file) : input.file
    const attach: { uri: string; as?: string } | undefined = typeof given === "string" ? { uri: given } : given
    if (attach && !attach.uri) throw new Error("`file` needs a `uri`")
    if (!input.text && !input.html && !input.file) throw new Error("Give a text, html or a file")
    if (input.edit && (input.file || input.reply_to)) throw new Error("`edit` replaces the text of a message: it takes no `file` or `reply_to`")
    const self = await ensure(sessionID)
    const roomId = await resolve(sessionID, self, input.to)
    const original = input.edit ?? input.reply_to
    const related = original ? await roomEvent(self, roomId, original, input.to) : undefined
    if (input.edit && related.sender !== self) throw new Error("Only your own messages can be edited")
    const mentioned = userIDs(input.mention)
    // Mentioning someone outside the room invites them, so the mention can reach them.
    const members = mentioned.length ? await matrix.joinedMembers(self, roomId) : []
    for (const user of mentioned.filter((id) => !members.includes(id))) {
      const sessionID = parseTarget(identity, input.mention![mentioned.indexOf(user)]).sessionID
      if (sessionID && (await localSession(sessionID))) await ensure(sessionID)
      await matrix.invite(self, roomId, user).catch((error) => log("invite failed", user, error))
    }
    const file = attach ? await attachment(sessionID, self, attach.uri, attach.as) : undefined
    // With a file, the text is its caption; without one, the body is the file name.
    const text = input.text || (input.html ? htmlToText(input.html) : (file!.filename ?? "file"))
    const html = input.html || (input.text ? markdownToHTML(input.text) : undefined)
    const prefixed = mentioned.filter((id) => !text.includes(id))
    const prefix = prefixed.join(" ")
    const pills = prefix ? `${prefixed.map((id) => `<a href="https://matrix.to/#/${id}">${id}</a>`).join(" ")}: ` : ""
    // The mentions go inside a leading paragraph, or they would sit on a line of their own.
    const formatted = html?.startsWith("<p>") ? `<p>${pills}${html.slice(3)}` : `${pills}${html}`
    const body = prefix ? `${prefix}: ${text}` : text
    const content: Record<string, unknown> = {
      msgtype: "m.text",
      ...file,
      body,
      ...(html ? { format: "org.matrix.custom.html", formatted_body: formatted } : {}),
      "m.mentions": { user_ids: mentioned },
    }
    if (input.reply_to) {
      content["m.relates_to"] = { "m.in_reply_to": { event_id: input.reply_to } }
      // Replies mention the original's sender, so it is notified.
      if (related.sender !== self && !mentioned.includes(related.sender)) content["m.mentions"] = { user_ids: [...mentioned, related.sender] }
    }
    const eventId = await matrix.send(
      self,
      roomId,
      input.edit
        ? {
            ...content,
            body: `* ${body}`,
            ...(html ? { formatted_body: `* ${formatted}` } : {}),
            // Only users the original did not mention are notified of the edit.
            "m.mentions": { user_ids: mentioned.filter((id) => !(related.content?.["m.mentions"]?.user_ids ?? []).includes(id)) },
            "m.new_content": content,
            "m.relates_to": { rel_type: "m.replace", event_id: input.edit },
          }
        : content,
    )
    return { from: self, room: roomId, event_id: eventId }
  }

  async function read(sessionID: string, input: { room: string; limit?: number }) {
    const self = await ensure(sessionID)
    const target = parseTarget(identity, input.room)
    let roomId: string
    let dmWith: string | undefined
    if (target.kind === "user") {
      roomId = (await storage().get(`dm:${sessionID}:${target.userID}`)) as string
      if (!roomId) return `No DM with ${target.userID} yet.`
      dmWith = target.userID
    } else {
      roomId = await room(self, target)
    }
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
    const { messages, reactions } = await matrix.messages(self, roomId, limit)
    if (!messages.length) return "No messages."
    // Oldest first, so keys and senders keep the order they were given in. Removed reactions are redacted, which
    // strips their relation.
    const byEvent = new Map<string, Map<string, string[]>>()
    for (const reaction of reactions.reverse()) {
      const relation = reaction.content?.["m.relates_to"]
      if (relation?.rel_type !== "m.annotation" || typeof relation.key !== "string") continue
      const keys = byEvent.get(relation.event_id) ?? new Map<string, string[]>()
      byEvent.set(relation.event_id, keys)
      const senders = keys.get(relation.key) ?? []
      keys.set(relation.key, senders)
      if (!senders.includes(reaction.sender)) senders.push(reaction.sender)
    }
    const lines: string[] = []
    for (const event of messages) {
      const message = await toReceived(self, roomId, event, dmWith)
      const keys = byEvent.get(event.event_id)
      if (keys) message.reactions = [...keys].map(([key, senders]) => ({ key, senders }))
      lines.push(formatMessage(identity, self, message))
    }
    return [`You are ${self}.`, "", ...lines, "", TRUST_NOTE].join("\n")
  }

  async function react(sessionID: string, input: { room: string; event: string; key: string }) {
    const self = await ensure(sessionID)
    const roomId = await resolve(sessionID, self, input.room)
    await roomEvent(self, roomId, input.event, input.room)
    const eventId = await matrix.sendEvent(self, roomId, "m.reaction", {
      "m.relates_to": { rel_type: "m.annotation", event_id: input.event, key: input.key },
    })
    return { from: self, room: roomId, event_id: eventId }
  }

  async function api(sessionID: string, input: { method: string; path: string; query?: Record<string, unknown>; body?: unknown }) {
    const path = checkClientPath(input.path)
    const self = await ensure(sessionID)
    const query = Object.fromEntries(Object.entries(input.query ?? {}).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]))
    // Some callers send the body as a JSON string; sent as is, it would be a JSON string, not an object.
    const body = typeof input.body === "string" ? parseJSONBody(input.body) : input.body
    const result = await matrix.call(self, input.method.toUpperCase(), path, { query, body })
    const text = JSON.stringify({ as: self, ...result }, null, 1)
    return text.length <= MAX_API_CHARS ? text : `${text.slice(0, MAX_API_CHARS)}\n[truncated at ${MAX_API_CHARS} of ${text.length} characters; narrow the request, e.g. with limit or filter]`
  }

  let spec: Promise<Operation[]> | undefined
  function specOperations() {
    spec ??= (async () => {
      const url = specURL(await matrix.versions())
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Could not load the API description from ${url}: ${response.status}`)
      log("loaded", url)
      return operations(await response.json())
    })()
    spec.catch(() => (spec = undefined))
    return spec
  }

  async function openapi(input: { path?: string; method?: string; search?: string }) {
    const all = await specOperations()
    if (input.path) {
      const found = findOperations(all, input.path, input.method)
      if (!found.length) return `No endpoint matches ${input.method ? `${input.method.toUpperCase()} ` : ""}${input.path}. Find it with \`search\`.`
      if (found.length > 3) return `${found.length} endpoints match; give \`method\`:\n${found.map(listLine).join("\n")}`
      return found.map((op) => JSON.stringify(describeOperation(op))).join("\n\n")
    }
    if (input.search) {
      const found = searchOperations(all, input.search)
      if (!found.length) return `No endpoint matches "${input.search}". Categories: ${categories(all).join(", ")}`
      const shown = found.slice(0, MAX_RESULTS).map(listLine)
      return found.length > MAX_RESULTS ? `${shown.join("\n")}\n[${found.length - MAX_RESULTS} more; narrow the search]` : shown.join("\n")
    }
    return `Categories (endpoints), searchable by name: ${categories(all).join(", ")}`
  }

  async function rooms(sessionID: string) {
    const self = await ensure(sessionID)
    const out = []
    for (const roomId of await matrix.joinedRooms(self)) {
      const dmWith = (await storage().get(`dmroom:${sessionID}:${roomId}`)) as string | undefined
      const members = await matrix.joinedMembers(self, roomId)
      out.push({
        room: roomId,
        label: dmWith ? `DM with ${dmWith} (${describeSender(identity, dmWith, self)})` : await roomLabel(self, roomId),
        members: members.length,
      })
    }
    return { you: self, rooms: out }
  }

  const json = (value: unknown) => ({ content: JSON.stringify(value, null, 2) })
  await ctx.tool.transform((editor: any) => {
    editor.add({
      name: "matrix_whoami",
      description:
        "Show this session's Matrix account (creating it if needed), your user's account, and how addressing works. Sessions get a Matrix account only once they use Matrix.",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { codemode: false },
      execute: async (_input: unknown, context: any) =>
        json({
          you: await ensure(context.sessionID),
          your_user: humanID(identity),
          addressing:
            '`to` accepts "user" (your user), a session ID (ses_...), @user:server, !room:server or #alias. Sessions of your user are @' +
            `${sessionLocalpart(identity, "<session id, lowercase>")}:${identity.serverName}.`,
        }),
    })
    editor.add({
      name: "matrix_send",
      description:
        'Send a Matrix chat message as this session. `to`: "user" for your user, a session ID (ses_...) or @user:server for a direct message, or a room (#alias or !room:server). A #alias room on this homeserver is created if missing, with your user invited. Local sessions you message get an account immediately. Recipients are notified of DMs and mentions only, so use `mention` to get a session\'s or person\'s attention in a room. `file` attaches a file (images are shown inline), with `text` as its caption. `reply_to` quotes a message and `edit` replaces one of yours, both by the event ID shown with each message.',
      input: {
        type: "object",
        properties: {
          to: { type: "string", description: 'Recipient: "user", ses_..., @user:server, #alias or !room:server.' },
          text: {
            type: "string",
            description: "Message text in Markdown (rendered by the recipient's client; newlines are line breaks), or the caption of `file`.",
          },
          html: {
            type: "string",
            description:
              'HTML to send as is instead of rendering `text`, for formatting Markdown cannot express. Clients render a subset (no CSS classes or scripts). `text` is then the plain-text fallback; without it, the tags are stripped. For FluffyChat: color only works as <span data-mx-color="#rrggbb"> (also data-mx-bg-color), not on <font>; put a <br> after </summary> in <details>, and before a list that follows text inside an element; use <strong> and <del>, not <b> and <strike>; <caption> and <input> are dropped.',
          },
          file: {
            description:
              "File to attach: a path (absolute or relative to the session's directory), a file:// URL, or an mxc:// URI from matrix_upload. Or {uri, as} to choose how clients show it.",
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  uri: { type: "string", description: "A path, file:// URL or mxc:// URI." },
                  as: {
                    type: "string",
                    enum: ["image", "video", "audio", "file"],
                    description: "How clients show the file (its msgtype). Default: from the file's extension. Required for an mxc:// URI not from matrix_upload.",
                  },
                },
                required: ["uri"],
                additionalProperties: false,
              },
            ],
          },
          mention: { type: "array", items: { type: "string" }, description: 'Users or sessions to mention ("user", ses_..., @user:server).' },
          reply_to: { type: "string", description: "Event ID of a message in that room to reply to (quote). Its sender is notified." },
          edit: { type: "string", description: "Event ID of one of your own messages in that room to replace with this `text`/`html`." },
        },
        required: ["to"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input: any, context: any) => json(await send(context.sessionID, input)),
    })
    editor.add({
      name: "matrix_read",
      description:
        "Read the most recent messages in a Matrix room or DM (oldest first), with their reactions. `room`: #alias, !room:server, or a DM partner (\"user\", ses_..., @user:server). Joins a team room if needed.",
      input: {
        type: "object",
        properties: {
          room: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20." },
        },
        required: ["room"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input: any, context: any) => ({ content: await read(context.sessionID, input) }),
    })
    editor.add({
      name: "matrix_upload",
      description:
        "Upload a file to the Matrix media repository and get its mxc:// URI, to send it (matrix_send `file`, e.g. to several rooms) or use it with matrix_api (avatars, room avatars). To just send a file, give matrix_send `file` a path instead.",
      input: {
        type: "object",
        properties: { file: { type: "string", description: "A path (absolute or relative to the session's directory) or a file:// URL." } },
        required: ["file"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input: any, context: any) => {
        const self = await ensure(context.sessionID)
        return json(await upload(context.sessionID, self, input.file))
      },
    })
    editor.add({
      name: "matrix_download",
      description:
        "Download a file sent over Matrix (the mxc:// URI shown with an attachment) and get its local path, to open it with the read tool (images and PDFs included) or use it otherwise.",
      input: {
        type: "object",
        properties: { uri: { type: "string", description: "The mxc:// URI." } },
        required: ["uri"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input: any, context: any) => {
        const self = await ensure(context.sessionID)
        return json(await download(context.sessionID, self, input.uri))
      },
    })
    editor.add({
      name: "matrix_react",
      description: "React to a Matrix message with an emoji (e.g. ✅ to acknowledge it). `room` is as in matrix_send's `to`.",
      input: {
        type: "object",
        properties: {
          room: { type: "string", description: '"user", ses_..., @user:server, #alias or !room:server.' },
          event: { type: "string", description: "Event ID of the message." },
          key: { type: "string", description: "The reaction, usually one emoji." },
        },
        required: ["room", "event", "key"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input: any, context: any) => json(await react(context.sessionID, input)),
    })
    editor.add({
      name: "matrix_api",
      description:
        "Call any Matrix Client-Server API endpoint as this session's account, for what the other matrix_* tools do not do (redactions, room state such as topic or name, pins, threads, profiles, members...). Look endpoints up with matrix_openapi. Room IDs come from matrix_rooms and event IDs from messages; URL-encode them in `path`. Returns the status and response. Event content formats (e.g. m.room.pinned_events) are described at https://spec.matrix.org/latest/client-server-api/#events, not in the OpenAPI description.",
      input: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "PUT", "POST", "DELETE"] },
          path: { type: "string", description: "Full path, e.g. /_matrix/client/v3/rooms/%21abc%3Aexample.org/state/m.room.topic/" },
          query: { type: "object", additionalProperties: true, description: "Query parameters; objects (e.g. filter) are sent as JSON." },
          body: { type: "object", additionalProperties: true, description: "JSON request body (an object; {} for endpoints that take an empty one)." },
        },
        required: ["method", "path"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input: any, context: any) => ({ content: await api(context.sessionID, input) }),
    })
    editor.add({
      name: "matrix_openapi",
      description:
        "Look up the Matrix Client-Server API's OpenAPI description, for matrix_api, in the spec version the homeserver supports. `path` gives one endpoint's parameters, request and response (placeholders like {roomId} or real IDs both work; `method` narrows it). `search` lists endpoints whose path, summary or category contain all its words. Neither lists the categories.",
      input: {
        type: "object",
        properties: {
          path: { type: "string", description: "e.g. /_matrix/client/v3/rooms/{roomId}/redact/{eventId}/{txnId}" },
          method: { type: "string", enum: ["GET", "PUT", "POST", "DELETE", "PATCH"] },
          search: { type: "string", description: 'Words, e.g. "redact" or "state".' },
        },
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input: any) => ({ content: await openapi(input) }),
    })
    editor.add({
      name: "matrix_rooms",
      description: "List the Matrix rooms and DMs this session is in.",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { codemode: false },
      execute: async (_input: unknown, context: any) => json(await rooms(context.sessionID)),
    })
  })

  // Runs before each model call of the agent loop, with the messages it sends.
  const contextHook = await ctx.session.hook("context", (event: any) => sendSeenReceipts(event.sessionID, event.messages))

  const events = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: events.signal }) as AsyncIterable<any>) {
        const sessionID = event?.data?.sessionID
        if (!sessionID) continue
        if (event.type === "session.created") {
          const session = await localSession(sessionID)
          if (session?.metadata?.opThreads || session?.metadata?.opWorkflow) await ensure(sessionID)
        } else if (event.type === "session.renamed") {
          const account = (await storage().get(`account:${sessionID}`)) as { userID: string } | undefined
          const roomId = (await storage().get(`dm:${sessionID}:${humanID(identity)}`)) as string | undefined
          if (account) await matrix.setDisplayName(account.userID, displayName(sessionID, event.data.title))
          if (account && roomId && event.data.title) {
            await matrix.setRoomName(account.userID, roomId, event.data.title).catch((error) => log("room name failed", error))
          }
        } else if (event.type === "session.execution.started") {
          state.running.add(sessionID)
        } else if (event.type === "session.execution.succeeded" || event.type === "session.execution.interrupted") {
          state.running.delete(sessionID)
        } else if (event.type === "session.execution.failed") {
          state.running.delete(sessionID)
          // The human only sees what the session sends, so a session that dies would otherwise go silent.
          const account = (await storage().get(`account:${sessionID}`)) as { userID: string } | undefined
          const roomId = (await storage().get(`dm:${sessionID}:${humanID(identity)}`)) as string | undefined
          if (account && roomId) {
            const body = `This session stopped with an error: ${event.data.error?.message ?? "unknown error"}`
            await matrix.send(account.userID, roomId, { msgtype: "m.notice", body }).catch((error) => log("notify failed", error))
          }
        } else if (event.type === "session.deleted") {
          state.loops.get(sessionID)?.abort()
          state.ensuring.delete(sessionID)
          state.unread.delete(sessionID)
          await storage().remove(`account:${sessionID}`)
          await storage().remove(`since:${sessionID}`)
          await storage().remove(`dispatched:${sessionID}`)
        }
      }
    } catch (error) {
      if (!events.signal.aborted) log("event error", error)
    }
  })()

  // Resume loops for sessions that already have accounts.
  let after: string | undefined
  do {
    const page = await ctx.storage.scan({ prefix: "account:", after, limit: 200 })
    for (const entry of page.entries) {
      const sessionID = entry.key.slice("account:".length)
      if (await localSession(sessionID)) startLoop(sessionID, (entry.value as { userID: string }).userID)
    }
    after = page.next
  } while (after)

  if (options.workspace) {
    const workspace = options.workspace
    void (async () => {
      while (!events.signal.aborted) {
        try {
          return await startDispatcher(workspace)
        } catch (error) {
          log("dispatcher error", error)
          await sleep(RETRY_MS, events.signal)
        }
      }
    })()
  }

  return async () => {
    events.abort()
    await contextHook.dispose()
    state.ctxs.delete(ctx)
    if (state.ctxs.size === 0) {
      for (const controller of state.loops.values()) controller.abort()
      state.loops.clear()
      state.ensuring.clear()
    }
  }
}

// Plain object rather than `Plugin.define`: a plugin outside the OpenCode repository cannot resolve
// "@opencode/plugin" at runtime, and `define` only returns its argument.
export default {
  id: "agent-matrix",
  async setup(ctx: any) {
    return setupAgentMatrix(ctx)
  },
}
