// HTTP control surface for the settings page: /api/dsh-gateway/*.
// The page polls GET /state and issues channel CRUD + test + restart here.
// Same-origin only: reject cross-origin requests; the host binds loopback.
import { randomUUID } from 'node:crypto'
import {
  channelLabel,
  channelSchema,
  makeShortId,
  refFor,
} from './domain.mjs'
import { describeChannelError } from './errors.mjs'

const BODY_LIMIT = 1_000_000

export function registerRoutes(ctx, deps) {
  const handle = (req, res) => dispatch(req, res).catch((error) => {
    ctx.logger.error('dsh-gateway: http handler failed: %s', error)
    // Anything that reaches here failed on its way to the platform: say what to
    // do about it, and keep the platform's own wording beside the advice.
    sendJson(res, 500, { error: describeChannelError(error) })
  })
  // Cached preset lookup. It lives up here on purpose: everything below the
  // `return` is the dead region that may hold function declarations only, and a
  // `let` down there stays in its temporal dead zone.
  let presetInfo
  let presetResolvedAt = 0
  // The webserver returns a disposer and ties it to nobody. A prefix route that
  // outlives the plugin keeps its path taken — a re-enable then dies on
  // "duplicate prefix route" — and keeps answering through a disposed context
  // ("cannot get required service ... in inactive context").
  return ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/api/dsh-gateway', handler: handle }),
    'dsh-gateway.http',
  )

  // ------------------------------------------------------------------ utils

  function sendJson(res, code, body) {
    const data = JSON.stringify(body)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) })
    res.end(data)
  }

  function sameOrigin(req, res) {
    const origin = req.headers.origin
    if (origin) {
      const host = req.headers.host ?? ''
      if (origin !== `http://${host}` && origin !== `https://${host}`) {
        sendJson(res, 403, { error: 'cross-origin request rejected' })
        return false
      }
    }
    return true
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > BODY_LIMIT) {
          reject(new Error('request body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
        } catch (error) {
          reject(new Error(`invalid JSON body: ${error}`))
        }
      })
      req.on('error', reject)
    })
  }

  function requireSidecar(res) {
    if (!deps.sidecar.running) {
      sendJson(res, 503, { error: 'sidecar not running (check pythonBin config / sidecar logs)' })
      return null
    }
    return deps.sidecar
  }

  // ------------------------------------------------------------ state read

  /**
   * The deployment's agent preset, resolved once and cached: the page only
   * needs to say which composition IM sessions get, and answering it on every
   * poll would re-audit the preset's rows each time.
   */
  async function describeAgentPreset() {
    if (ctx.get?.('agentPresets') === undefined) return null
    const now = Date.now()
    if (presetInfo !== undefined && now - presetResolvedAt < 30_000) return presetInfo
    try {
      const resolved = await ctx.get('agentPresets').resolve(undefined)
      presetInfo = { id: resolved.id, broken: resolved.broken ?? null }
    } catch (error) {
      presetInfo = { id: null, broken: String(error?.message ?? error) }
    }
    presetResolvedAt = now
    return presetInfo
  }

  async function assembleState() {
    const channels = []
    for (const [id, record] of deps.tables.channels.entries()) {
      const status = deps.state.status.get(id)
      const secrets = {}
      for (const [field, ref] of Object.entries(record.secretRefs ?? {})) {
        const info = await ctx.credentials.describe(ref).catch(() => undefined)
        secrets[field] = { configured: Boolean(info?.configured) }
      }
      const connected = Boolean(status?.connected)
      channels.push({
        ...record,
        secrets,
        // `connected` stays the one boolean the rail needs; `status` carries the
        // reason, so a channel that never came up is not indistinguishable from
        // one that is still coming up.
        connected,
        status: {
          connected,
          reason: status?.reason ?? (record.enabled ? null : 'disabled'),
          detail: status?.detail ?? null,
          updatedAt: status?.updatedAt ?? null,
        },
      })
    }
    channels.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    // Where a session's compaction engine lives. A roster deployment composes it
    // inside each agent preset and resolves it per session; a preset-free one
    // publishes it on the host plane; a deployment with neither cannot compact,
    // and only then is the per-channel threshold not worth offering.
    const composesPresets = ctx.get?.('agentPresets') !== undefined
    const hostCompaction = Boolean(ctx.get?.('compaction')?.compactNow)
    return {
      sidecar: {
        running: deps.sidecar.running,
        pid: deps.sidecar.pid,
        gatewayVersion: deps.state.gatewayVersion,
        startedAt: deps.state.startedAt,
        lastError: deps.state.lastError,
        pythonBin: deps.sidecar.pythonBin ?? null,
      },
      runtime: deps.runtime?.status ?? null,
      channels,
      kinds: deps.state.kinds ?? [],
      compaction: {
        available: hostCompaction || composesPresets,
        scope: hostCompaction ? 'host' : composesPresets ? 'agent-preset' : null,
      },
      // Which agent preset the bridge composes a new IM session from; null when
      // this deployment keeps its capabilities on the host plane.
      agentPreset: await describeAgentPreset(),
      // Problems the sidecar found between the channel catalogue and the
      // installed octop-gateway; the page shows them instead of failing silently.
      drift: deps.state.drift ?? [],
      workspaces: ctx.workspaceRegistry.list().map((workspace) => ({
        id: workspace.id,
        title: workspace.title,
        path: workspace.path,
      })),
    }
  }

  // ------------------------------------------------------------ secret sync

  /** secrets payload: {field: string(new) | null(clear)}; absent = unchanged. */
  async function applySecrets(channelId, secretRefs, secrets) {
    for (const [field, value] of Object.entries(secrets ?? {})) {
      const ref = refFor(channelId, field)
      if (value === null) {
        await ctx.credentials.unset(ref).catch((error) => ctx.logger.warn('dsh-gateway: unset %s failed: %s', ref, error))
        delete secretRefs[field]
      } else if (typeof value === 'string' && value.length > 0) {
        await ctx.credentials.set(ref, value)
        secretRefs[field] = ref
      }
    }
  }

  async function resolveSecrets(record) {
    const secrets = {}
    for (const [field, ref] of Object.entries(record.secretRefs ?? {})) {
      const resolved = await ctx.credentials.resolve(ref).catch(() => undefined)
      if (resolved?.value) secrets[field] = resolved.value
      else ctx.logger.warn('dsh-gateway: secret %s of channel %s missing value', field, record.id)
    }
    return secrets
  }

  async function syncChannelToSidecar(sidecar, record, { restart } = {}) {
    if (!record.enabled) {
      await sidecar.request({ op: 'remove_channel', channel_id: record.id })
      deps.setStatus(record.id, { connected: false, reason: 'disabled', detail: null })
      return
    }
    if (restart) await sidecar.request({ op: 'remove_channel', channel_id: record.id }).catch(() => {})
    const secrets = await resolveSecrets(record)
    try {
      await sidecar.request({
        op: 'add_channel',
        channel_id: record.id,
        kind: record.kind,
        config: record.config,
        secrets,
      })
      // Registered: from here the sidecar's own status frames say whether it is
      // up. Until one arrives, "connecting" is the honest answer.
      deps.setStatus(record.id, { connected: false, reason: 'connecting', detail: null })
    } catch (error) {
      // The registration itself failed — that is a different fact from "the
      // platform has not answered yet", and it is the one the page must show.
      deps.setStatus(record.id, {
        connected: false,
        reason: 'error',
        detail: String(error?.message ?? error),
      })
      throw error
    }
  }

  // -------------------------------------------------------------- dispatch

  async function dispatch(req, res) {
    if (!sameOrigin(req, res)) return
    const url = new URL(req.url ?? '/', 'http://local')
    const pathname = url.pathname.replace(/^\/+/, '') // e.g. api/dsh-gateway/state
    const segments = pathname.split('/').filter(Boolean)
    // ['api','dsh-gateway', ...rest]
    const rest = segments.slice(2)

    if (req.method === 'GET' && rest.length === 1 && rest[0] === 'state') {
      return sendJson(res, 200, await assembleState())
    }

    // ------------------------------------------------- scan-to-create (QR)
    // The sidecar owns the login session; these three routes only start it,
    // read its status, and stop it. Credentials cross this boundary at most
    // once and are never logged or persisted.
    if (req.method === 'POST' && rest.length === 1 && rest[0] === 'qr') {
      const sidecar = requireSidecar(res)
      if (!sidecar) return
      const body = await readBody(req)
      const kind = String(body.kind ?? '')
      const kindDef = (deps.state.kinds ?? []).find((entry) => entry.kind === kind)
      if (!kindDef) return sendJson(res, 400, { error: `unsupported kind: ${kind}` })
      if (!kindDef.quickConfig) return sendJson(res, 400, { error: `kind ${kind} has no scan-to-create flow` })
      const result = await sidecar.request({ op: 'qr_start', kind }, 30_000)
      return sendJson(res, 200, {
        task_id: result.task_id,
        kind,
        url: result.url,
        expiresInSec: result.expires_in_s ?? null,
        quickConfig: kindDef.quickConfig,
      })
    }

    if (req.method === 'GET' && rest.length === 2 && rest[0] === 'qr') {
      const sidecar = requireSidecar(res)
      if (!sidecar) return
      const result = await sidecar.request({ op: 'qr_poll', task_id: String(rest[1]) }, 30_000)
      // A delivered credential set is forwarded verbatim and logged nowhere.
      return sendJson(res, 200, {
        status: result.status,
        url: result.url ?? null,
        message: result.message ?? null,
        fills: result.fills ?? null,
        secrets: result.secrets ?? null,
      })
    }

    if (req.method === 'DELETE' && rest.length === 2 && rest[0] === 'qr') {
      const sidecar = requireSidecar(res)
      if (!sidecar) return
      await sidecar.request({ op: 'qr_cancel', task_id: String(rest[1]) }, 10_000).catch(() => {})
      return sendJson(res, 200, { ok: true })
    }

    if (req.method === 'POST' && rest.length === 1 && rest[0] === 'channels') {
      const sidecar = requireSidecar(res)
      if (!sidecar) return
      const body = await readBody(req)
      return saveChannel(sidecar, body, res)
    }

    if (req.method === 'POST' && rest.length === 2 && rest[0] === 'channels' && rest[1] === 'test') {
      const sidecar = requireSidecar(res)
      if (!sidecar) return
      const body = await readBody(req)
      const kinds = deps.state.kinds ?? []
      const kindDef = kinds.find((kind) => kind.kind === body.kind)
      if (!kindDef) return sendJson(res, 400, { error: `unsupported kind: ${body.kind}` })
      // Existing channel: fall back to stored secrets for fields the form left
      // empty (undefined) — explicit null still means "cleared, do not use".
      const secrets = { ...(body.secrets ?? {}) }
      if (body.channelId) {
        const record = deps.tables.channels.get(String(body.channelId))
        if (record) {
          for (const [field, ref] of Object.entries(record.secretRefs ?? {})) {
            if (secrets[field] !== undefined) continue
            const resolved = await ctx.credentials.resolve(ref).catch(() => undefined)
            if (resolved?.value) secrets[field] = resolved.value
          }
        }
      }
      // Probe the config the channel would actually run with.
      const result = await sidecar.request(
        { op: 'test_channel', kind: body.kind, config: { ...(body.config ?? {}), ...(kindDef.fixed ?? {}) }, secrets },
        60_000,
      )
      return sendJson(res, 200, {
        connected: Boolean(result.connected),
        reason: result.reason ?? null,
        detail: result.connected ? null : describeChannelError(result.detail ?? 'connection failed'),
      })
    }

    if (req.method === 'POST' && rest.length === 3 && rest[0] === 'channels' && rest[2] === 'toggle') {
      const sidecar = requireSidecar(res)
      if (!sidecar) return
      const record = deps.tables.channels.get(rest[1])
      if (!record) return sendJson(res, 404, { error: 'channel not found' })
      const body = await readBody(req)
      const enabled = Boolean(body.enabled)
      record.enabled = enabled
      record.updatedAt = new Date().toISOString()
      await deps.tables.channels.put(record.id, record)
      // Same split as a save: the switch flipped, and whether the platform
      // accepted the connection is a second fact with its own sentence.
      let startError = null
      try {
        await syncChannelToSidecar(sidecar, record, { restart: true })
      } catch (error) {
        startError = describeChannelError(error)
        ctx.logger.warn('dsh-gateway: channel %s (%s) toggle did not start: %s', record.id, record.kind, error)
      }
      return sendJson(res, 200, { ok: true, startError })
    }

    if (req.method === 'DELETE' && rest.length === 2 && rest[0] === 'channels') {
      const sidecar = requireSidecar(res)
      if (!sidecar) return
      const record = deps.tables.channels.get(rest[1])
      if (!record) return sendJson(res, 404, { error: 'channel not found' })
      await sidecar.request({ op: 'remove_channel', channel_id: record.id }).catch(() => {})
      // Channel first, then its routes: a crash in between leaves routes pointing
      // at a missing channel, which `dropOrphanRoutes` sweeps on the next load.
      // The other order would leave a live channel with no routing.
      await deps.tables.channels.delete(record.id)
      for (const [key, route] of [...deps.tables.routes.entries()]) {
        if (route.channelId !== record.id) continue
        try {
          await deps.tables.routes.delete(key)
        } catch (error) {
          ctx.logger.warn('dsh-gateway: could not delete route %s of the removed channel: %s', key, error)
        }
        // The router keeps its own view of the same rows; a stale entry would
        // keep a conversation mapped to a channel that no longer exists.
        deps.router.routes.delete(key)
      }
      for (const [field, ref] of Object.entries(record.secretRefs ?? {})) {
        await ctx.credentials.unset(ref).catch(() => {})
        void field
      }
      deps.state.status.delete(record.id)
      return sendJson(res, 200, { ok: true })
    }

    if (req.method === 'POST' && rest.length === 2 && rest[0] === 'sidecar' && rest[1] === 'restart') {
      await deps.restartSidecar()
      return sendJson(res, 200, { ok: true, running: deps.sidecar.running })
    }

    // Re-probe the Python runtime and, if needed, rebuild the managed venv and
    // reinstall the dependency. Long-running by nature (venv + pip), so it is
    // started in the background and the page follows `runtime.phase` on /state.
    if (req.method === 'POST' && rest.length === 2 && rest[0] === 'runtime' && rest[1] === 'bootstrap') {
      if (typeof deps.bootstrapRuntime !== 'function') return sendJson(res, 500, { error: 'runtime bootstrap unavailable' })
      Promise.resolve(deps.bootstrapRuntime()).catch(() => {})
      return sendJson(res, 202, { ok: true, started: true })
    }

    return sendJson(res, 404, { error: `no route: ${req.method} ${pathname}` })
  }

  /** Flatten a kind's control groups into `{flat, nested}` lookup tables. */
  function controlsOf(kindDef) {
    const flat = new Map()
    const nested = new Map()
    for (const group of kindDef?.groups ?? []) {
      for (const control of group.controls ?? []) {
        if (group.path) {
          if (!nested.has(group.path)) nested.set(group.path, [])
          nested.get(group.path).push(control)
        } else {
          flat.set(control.name, control)
        }
      }
    }
    return { flat, nested }
  }

  // NOTE: every declaration below the `return` above is unreachable at
  // registration time. Function declarations are hoisted, so they still work as
  // handlers — but a `const`/`let` here would stay in its temporal dead zone and
  // throw "Cannot access ... before initialization" on first use. This region
  // must stay function-declaration only.
  function isBlank(value) {
    return value === undefined || value === null || value === ''
  }

  /**
   * The channel's workspace access scope, as the page sends it.
   *
   * `all` = unrestricted, so the stored path list is emptied rather than kept
   * around: a stale list would silently re-apply if the mode ever came back.
   * `selected` = a whitelist, deduplicated; an empty one is rejected here
   * instead of leaving a channel that can reach no workspace at all.
   */
  function workspaceAccessFrom(input) {
    const mode = input?.mode === 'selected' ? 'selected' : 'all'
    const paths = Array.isArray(input?.paths)
      ? [...new Set(input.paths.map((path) => String(path ?? '').trim()).filter(Boolean))]
      : []
    if (mode === 'selected' && paths.length === 0) {
      return { error: '「指定工作区」至少需要选择一个工作区' }
    }
    return { value: { mode, paths: mode === 'selected' ? paths : [] } }
  }

  /** Every supplied config value must be a non-empty-ish value of its shape. */
  function cleanConfig(body, kindDef) {
    const config = {}
    for (const [name, value] of Object.entries(body.config ?? {})) {
      if (isBlank(value)) continue
      config[name] = value
    }
    for (const [name, fixed] of Object.entries(kindDef.fixed ?? {})) config[name] = fixed
    return config
  }

  /**
   * The value that identifies this account on the platform, per the catalogue's
   * `identity` control. Null when the kind declares none or the value is blank:
   * two channels cannot be told apart by account then, so nothing is merged and
   * nothing is refused.
   */
  function accountIdentity(kindDef, config) {
    const field = kindDef?.identity
    if (!field) return null
    const value = config?.[field]
    if (isBlank(value)) return null
    return { field, value: String(value).trim() }
  }

  /** The stored channel of the same kind that already holds this account. */
  function channelWithIdentity(kind, identity, exceptId) {
    if (!identity) return undefined
    for (const [id, stored] of deps.tables.channels.entries()) {
      if (id === exceptId) continue
      if (stored.kind !== kind) continue
      const value = stored.config?.[identity.field]
      if (isBlank(value)) continue
      if (String(value).trim() === identity.value) return stored
    }
    return undefined
  }

  /**
   * Pre-flight the mandatory controls so the page can name the missing field.
   * octop-gateway remains the authority — it raises on missing credentials when
   * the channel is built — so this only exists to make the failure readable.
   * A required secret already stored counts as satisfied unless it is cleared.
   */
  function missingRequired(kindDef, config, secrets, existingRefs) {
    const { flat, nested } = controlsOf(kindDef)
    const missing = []
    for (const [path, controls] of nested) {
      for (const control of controls) {
        if (!control.required) continue
        const value = (config[path] ?? {})[control.name]
        if (isBlank(value)) missing.push(control)
      }
    }
    for (const [name, control] of flat) {
      if (!control.required) continue
      if (control.secret) {
        const incoming = secrets?.[name]
        const stored = existingRefs?.[name]
        const satisfied = (!isBlank(incoming) && incoming !== null) || (incoming === undefined && stored)
        if (!satisfied) missing.push(control)
      } else if (isBlank(config[name])) {
        missing.push(control)
      }
    }
    return missing
  }

  async function saveChannel(sidecar, body, res) {
    const kinds = deps.state.kinds ?? []
    const kindDef = kinds.find((kind) => kind.kind === body.kind)
    if (!kindDef) return sendJson(res, 400, { error: `unsupported kind: ${body.kind}` })
    const access = workspaceAccessFrom(body.workspaceAccess)
    if (access.error) return sendJson(res, 400, { error: access.error, fields: ['workspaceAccess'] })

    const existing = body.id ? deps.tables.channels.get(String(body.id)) : undefined
    const config = cleanConfig(body, kindDef)
    // One account may be configured once. Two live channels holding the same
    // App ID / bot UIN are not two conversations, they are two pollers on one
    // login: the platform kicks one, or the two fight over every message. The
    // catalogue names the control that identifies the account, so a repeat
    // submission is routed onto the channel that already holds it.
    const identity = accountIdentity(kindDef, config)
    const twin = channelWithIdentity(body.kind, identity, existing?.id)
    if (existing && twin) {
      return sendJson(res, 409, {
        error: `该账号已经配置在通道「${twin.label}」上：同一账号只能配置一处，否则两个通道会争抢同一个登录`,
        fields: [identity.field],
      })
    }
    // A create whose account is already configured is an update of that channel,
    // not a second one — this is what makes a re-scan idempotent.
    const record0 = existing ?? twin
    const missing = missingRequired(kindDef, config, body.secrets, record0?.secretRefs)
    if (missing.length > 0) {
      return sendJson(res, 400, {
        error: `请先填写：${missing.map((control) => control.label ?? control.name).join('、')}`,
        fields: missing.map((control) => control.name),
      })
    }

    const now = new Date().toISOString()
    let record = record0
    const adopted = Boolean(record0 && !existing)
    const creating = !record
    if (creating) {
      // The name is derived, never typed: the platform name plus a public id.
      // Two channels of one platform stay distinguishable without asking the
      // user to invent a label.
      const taken = new Set()
      for (const [, stored] of deps.tables.channels.entries()) {
        if (stored.shortId) taken.add(stored.shortId)
      }
      const shortId = makeShortId(taken)
      record = channelSchema.parse({
        id: randomUUID(),
        kind: body.kind,
        label: channelLabel(kindDef.label ?? kindDef.kind, shortId),
        shortId,
        enabled: true,
        config,
        secretRefs: {},
        workspaceAccess: access.value,
        createdAt: now,
        updatedAt: now,
      })
    } else {
      record = {
        ...record,
        config,
        // Adopting an existing account refreshes its credentials; it does not
        // silently re-decide where its conversations may run. The submission was
        // a "new channel" form, so its access scope is a default, not a choice —
        // keep the one the channel already carries.
        workspaceAccess: adopted ? record.workspaceAccess : access.value,
        enabled: record.enabled,
        updatedAt: now,
      }
    }
    if (!adopted) {
      record.sessionPolicy = {
        compactEnabled: body.sessionPolicy?.compactEnabled !== false,
        compactThresholdPct: Math.min(100, Math.max(5, Number(body.sessionPolicy?.compactThresholdPct ?? 80))),
        archivePrevious: Boolean(body.sessionPolicy?.archivePrevious),
      }
    }

    await applySecrets(record.id, record.secretRefs, body.secrets)
    await deps.tables.channels.put(record.id, record)
    // An adopted or edited channel is taken off the sidecar first: it may be
    // live with the old credentials, and adding over a live registration is
    // refused by the gateway.
    //
    // A start failure is reported as `startError` on an otherwise successful save,
    // not as a failed save: the configuration IS stored, the channel just did not
    // come up, and the page says exactly that (plus the red tag from the status).
    let startError = null
    try {
      await syncChannelToSidecar(sidecar, record, { restart: !creating })
    } catch (error) {
      startError = describeChannelError(error)
      ctx.logger.warn('dsh-gateway: channel %s (%s) saved but did not start: %s', record.id, record.kind, error)
    }
    ctx.logger.info(
      'dsh-gateway: channel %s (%s) %s',
      record.id, record.kind,
      creating ? 'created' : adopted ? 'adopted onto the existing account' : 'updated',
    )
    return sendJson(res, 200, { ok: true, id: record.id, updated: adopted, startError })
  }
}
