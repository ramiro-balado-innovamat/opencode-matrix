import { readFileSync } from "node:fs"

// Minimal Matrix client-server API client acting through an appservice token. Every call names the
// account it acts as (`?user_id=`), which must be inside the appservice's exclusive namespace.

/** Most pages `messages` reads, so a room of mostly reactions cannot make it page back without end. */
const MESSAGE_PAGES = 5

export interface MatrixOptions {
  homeserver: string
  serverName: string
  asToken: string
}

export class MatrixError extends Error {
  constructor(
    readonly status: number,
    readonly errcode: string | undefined,
    message: string,
  ) {
    super(message)
  }
}

/** The as_token of an appservice registration file, or the content of a file holding only the token. */
export function readAsToken(file: string) {
  const text = readFileSync(file, "utf8")
  const registration = /^\s*"?as_token"?\s*:\s*"?([^"\s]+)"?\s*$/m.exec(text)
  if (registration) return registration[1]
  const token = text.trim()
  if (token && !/\s/.test(token)) return token
  throw new Error(`${file} holds neither an appservice registration (as_token) nor a token`)
}

/**
 * Checks a path for matrix_api: Client-Server API only, normalized, and not the endpoints that create accounts or
 * tokens (with the appservice token, those reach every account in its namespace).
 */
export function checkClientPath(path: string) {
  if (!path.startsWith("/_matrix/client/")) throw new Error("`path` must start with /_matrix/client/")
  if (/[?#]/.test(path)) throw new Error("Pass query parameters in `query`, not in `path`")
  if (new URL(path, "http://localhost").pathname !== path) throw new Error("`path` must be URL-encoded, without . or .. segments")
  if (/^\/_matrix\/client\/[^/]+\/(register|login|logout)(\/|$)/.test(path)) throw new Error("Registering, logging in and out are not allowed")
  return path
}

/** The file name in a Content-Disposition header (`filename*=utf-8''…` or `filename=…`). */
export function dispositionFilename(header: string): string | undefined {
  const encoded = /filename\*=utf-8''([^;]+)/i.exec(header)
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1])
    } catch {}
  }
  return /filename="?([^";]+)"?/i.exec(header)?.[1]
}

let txnCounter = 0

export class Matrix {
  constructor(readonly options: MatrixOptions) {}

  userID(localpart: string) {
    return `@${localpart}:${this.options.serverName}`
  }

  async request(
    method: string,
    path: string,
    as: string | undefined,
    { body, query, signal }: { body?: unknown; query?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<any> {
    const params = new URLSearchParams(query)
    if (as) params.set("user_id", as)
    const qs = params.toString()
    const response = await fetch(`${this.options.homeserver}/_matrix/client/v3${path}${qs ? `?${qs}` : ""}`, {
      method,
      signal,
      headers: { Authorization: `Bearer ${this.options.asToken}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json: any = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new MatrixError(response.status, json.errcode, `${method} ${path}: ${response.status} ${json.errcode ?? ""} ${json.error ?? ""}`.trim())
    }
    return json
  }

  /** Creates the account; an existing one is fine. */
  async register(localpart: string) {
    try {
      await this.request("POST", "/register", undefined, {
        body: { type: "m.login.application_service", username: localpart, inhibit_login: true },
      })
    } catch (error) {
      if (!(error instanceof MatrixError && error.errcode === "M_USER_IN_USE")) throw error
    }
    return this.userID(localpart)
  }

  setDisplayName(as: string, name: string) {
    return this.request("PUT", `/profile/${encodeURIComponent(as)}/displayname`, as, { body: { displayname: name } })
  }

  setRoomName(as: string, roomId: string, name: string) {
    return this.request("PUT", `/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`, as, { body: { name } })
  }

  async displayName(as: string, user: string): Promise<string | undefined> {
    try {
      return (await this.request("GET", `/profile/${encodeURIComponent(user)}/displayname`, as)).displayname
    } catch {
      return undefined
    }
  }

  sync(as: string, since: string | undefined, timeoutMs: number, filter: unknown, signal?: AbortSignal) {
    const query: Record<string, string> = { timeout: String(timeoutMs), filter: JSON.stringify(filter) }
    if (since) query.since = since
    return this.request("GET", "/sync", as, { query, signal })
  }

  async join(as: string, roomIdOrAlias: string): Promise<string> {
    return (await this.request("POST", `/join/${encodeURIComponent(roomIdOrAlias)}`, as, { body: {} })).room_id
  }

  leave(as: string, roomId: string) {
    return this.request("POST", `/rooms/${encodeURIComponent(roomId)}/leave`, as, { body: {} })
  }

  async createRoom(as: string, body: Record<string, unknown>): Promise<string> {
    return (await this.request("POST", "/createRoom", as, { body })).room_id
  }

  async resolveAlias(as: string, alias: string): Promise<string | undefined> {
    try {
      return (await this.request("GET", `/directory/room/${encodeURIComponent(alias)}`, as)).room_id
    } catch (error) {
      if (error instanceof MatrixError && error.errcode === "M_NOT_FOUND") return undefined
      throw error
    }
  }

  invite(as: string, roomId: string, user: string) {
    return this.request("POST", `/rooms/${encodeURIComponent(roomId)}/invite`, as, { body: { user_id: user } })
  }

  send(as: string, roomId: string, content: Record<string, unknown>): Promise<string> {
    return this.sendEvent(as, roomId, "m.room.message", content)
  }

  async sendEvent(as: string, roomId: string, type: string, content: Record<string, unknown>): Promise<string> {
    const txn = `${Date.now()}-${++txnCounter}`
    return (await this.request("PUT", `/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(type)}/${txn}`, as, { body: content })).event_id
  }

  /** Public read receipt: the sender's client shows `as` as having read up to `eventId`. */
  receipt(as: string, roomId: string, eventId: string) {
    return this.request("POST", `/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`, as, { body: {} })
  }

  event(as: string, roomId: string, eventId: string): Promise<any> {
    return this.request("GET", `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`, as)
  }

  /** The spec versions the homeserver supports. */
  async versions(): Promise<string[]> {
    const response = await fetch(`${this.options.homeserver}/_matrix/client/versions`)
    return response.ok ? (((await response.json()) as any).versions ?? []) : []
  }

  /**
   * Any request, as `as`, returning the status and response instead of throwing. `path` is the full path
   * (`/_matrix/client/...`); `user_id` and `access_token` in `query` are overridden.
   */
  async call(as: string, method: string, path: string, { query, body }: { query?: Record<string, string>; body?: unknown } = {}) {
    const params = new URLSearchParams(query)
    params.delete("access_token")
    params.set("user_id", as)
    const response = await fetch(`${this.options.homeserver}${path}?${params}`, {
      method,
      headers: { Authorization: `Bearer ${this.options.asToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const type = response.headers.get("content-type") ?? ""
    const data = new Uint8Array(await response.arrayBuffer())
    const text = () => new TextDecoder().decode(data)
    if (type.includes("json")) {
      try {
        return { status: response.status, body: JSON.parse(text()) as unknown }
      } catch {}
    }
    const readable = type.startsWith("text/") || type.includes("json")
    return { status: response.status, content_type: type, body: readable ? text() : `(${data.byteLength} bytes of ${type || "unknown type"})` }
  }

  /** Uploads to the media repository and returns the `mxc://` URI. */
  async upload(as: string, data: Uint8Array, filename: string, contentType: string): Promise<string> {
    const params = new URLSearchParams({ filename, user_id: as })
    const response = await fetch(`${this.options.homeserver}/_matrix/media/v3/upload?${params}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.options.asToken}`, "Content-Type": contentType },
      body: data,
    })
    const json: any = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new MatrixError(response.status, json.errcode, `POST /upload: ${response.status} ${json.errcode ?? ""} ${json.error ?? ""}`.trim())
    }
    return json.content_uri
  }

  /** Downloads an `mxc://` URI's content (authenticated media), refusing more than `maxBytes`. */
  async download(as: string, uri: string, maxBytes: number) {
    const match = /^mxc:\/\/([^/?#]+)\/([A-Za-z0-9_-]+)$/.exec(uri)
    if (!match) throw new Error(`Not an mxc:// URI: ${uri}`)
    const [, server, mediaId] = match
    const params = new URLSearchParams({ user_id: as })
    const response = await fetch(`${this.options.homeserver}/_matrix/client/v1/media/download/${encodeURIComponent(server)}/${mediaId}?${params}`, {
      headers: { Authorization: `Bearer ${this.options.asToken}` },
    })
    if (!response.ok) {
      const json: any = await response.json().catch(() => ({}))
      throw new MatrixError(response.status, json.errcode, `GET ${uri}: ${response.status} ${json.errcode ?? ""} ${json.error ?? ""}`.trim())
    }
    const tooLarge = () => new Error(`${uri} is larger than ${maxBytes} bytes`)
    if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
      await response.body?.cancel()
      throw tooLarge()
    }
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength
      if (size > maxBytes) throw tooLarge()
      chunks.push(chunk)
    }
    return {
      mediaId,
      data: Buffer.concat(chunks),
      mimetype: response.headers.get("content-type") ?? "application/octet-stream",
      filename: dispositionFilename(response.headers.get("content-disposition") ?? ""),
    }
  }

  /**
   * Newest `limit` message events, oldest first, and the reactions among them. A reaction comes after the message it
   * reacts to, so paging back until `limit` messages also finds the reactions to them (within MESSAGE_PAGES pages).
   */
  async messages(as: string, roomId: string, limit: number): Promise<{ messages: any[]; reactions: any[] }> {
    const filter = JSON.stringify({ types: ["m.room.message", "m.reaction"] })
    const messages: any[] = []
    const reactions: any[] = []
    let from: string | undefined
    for (let page = 0; page < MESSAGE_PAGES && messages.length < limit; page++) {
      const response = await this.request("GET", `/rooms/${encodeURIComponent(roomId)}/messages`, as, {
        query: { dir: "b", limit: String(Math.min(limit * 2, 100)), filter, ...(from ? { from } : {}) },
      })
      for (const event of response.chunk ?? []) {
        if (event.type === "m.reaction") reactions.push(event)
        else if (messages.length < limit) messages.push(event)
      }
      from = response.end
      if (!from || !response.chunk?.length) break
    }
    return { messages: messages.reverse(), reactions }
  }

  async joinedRooms(as: string): Promise<string[]> {
    return (await this.request("GET", "/joined_rooms", as)).joined_rooms
  }

  async joinedMembers(as: string, roomId: string): Promise<string[]> {
    return Object.keys((await this.request("GET", `/rooms/${encodeURIComponent(roomId)}/joined_members`, as)).joined)
  }

  async roomState(as: string, roomId: string, type: string): Promise<any | undefined> {
    try {
      return await this.request("GET", `/rooms/${encodeURIComponent(roomId)}/state/${type}/`, as)
    } catch {
      return undefined
    }
  }
}
