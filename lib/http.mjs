// HTTP control surface for the settings page: /api/dsh-gateway/*.
// The page polls GET /state and issues channel CRUD + test + restart here.
// Same-origin only: reject cross-origin requests; the host binds loopback.
import { randomUUID } from 'node:crypto'
import { refFor, channelSchema } from './domain.mjs'

const BODY_LIMIT = 1_000_000

export function registerRoutes(ctx, deps) {
  const handle = (req, res) => dispatch(req, res).catch((error) => {
    ctx.logger.error('dsh-gateway: http handler failed: %s', error)
    sendJson(res, 500, { error: String(error?.message ?? error) })
  })
  return ctx.webServer.register({ kind: 'prefix', path: '/api/dsh-gateway', handler: handle })

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

  async function assembleState() {
    const channels = []
    for (const [id, record] of deps.tables.channels.entries()) {
      const status = deps.state.status.get(id)
      const secrets = {}
      for (const [field, ref] of Object.entries(record.secretRefs ?? {})) {
        const info = await ctx.credentials.describe(ref).catch(() => undefined)
        secrets[field] = { configured: Boolean(info?.configured) }
      }
      channels.push({
        ...record,
        secrets,
        connected: status?.connected ?? false,
      })
    }
    channels.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    return {
      sidecar: {
        running: deps.sidecar.running,
        pid: deps.sidecar.pid,
        gatewayVersion: deps.state.gatewayVersion,
        startedAt: deps.state.startedAt,
        lastError: deps.state.lastError,
      },
      channels,
      kinds: deps.state.kinds ?? [],
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
      return
    }
    if (restart) await sidecar.request({ op: 'remove_channel', channel_id: record.id }).catch(() => {})
    const secrets = await resolveSecrets(record)
    await sidecar.request({
      op: 'add_channel',
      channel_id: record.id,
      kind: record.kind,
      config: record.config,
      secrets,
    })
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
      if (!kinds.some((kind) => kind.kind === body.kind)) return sendJson(res, 400, { error: `unknown kind: ${body.kind}` })
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
      const result = await sidecar.request(
        { op: 'test_channel', kind: body.kind, config: body.config ?? {}, secrets },
        60_000,
      )
      return sendJson(res, 200, { connected: Boolean(result.connected), detail: result.detail })
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
      await syncChannelToSidecar(sidecar, record, { restart: true })
      return sendJson(res, 200, { ok: true })
    }

    if (req.method === 'DELETE' && rest.length === 2 && rest[0] === 'channels') {
      const sidecar = requireSidecar(res)
      if (!sidecar) return
      const record = deps.tables.channels.get(rest[1])
      if (!record) return sendJson(res, 404, { error: 'channel not found' })
      await sidecar.request({ op: 'remove_channel', channel_id: record.id }).catch(() => {})
      await deps.tables.channels.delete(record.id)
      for (const [field, ref] of Object.entries(record.secretRefs ?? {})) {
        await ctx.credentials.unset(ref).catch(() => {})
        void field
      }
      return sendJson(res, 200, { ok: true })
    }

    if (req.method === 'POST' && rest.length === 2 && rest[0] === 'sidecar' && rest[1] === 'restart') {
      await deps.restartSidecar()
      return sendJson(res, 200, { ok: true, running: deps.sidecar.running })
    }

    return sendJson(res, 404, { error: `no route: ${req.method} ${pathname}` })
  }

  async function saveChannel(sidecar, body, res) {
    const kinds = deps.state.kinds ?? []
    const kindDef = kinds.find((kind) => kind.kind === body.kind)
    if (!kindDef) return sendJson(res, 400, { error: `unknown kind: ${body.kind}` })
    if (!body.label || !String(body.label).trim()) return sendJson(res, 400, { error: 'label is required' })
    const workspaceMode = body.workspaceMode === 'pinned' ? 'pinned' : 'default'
    const workspacePath = workspaceMode === 'pinned' ? String(body.workspacePath ?? '') : null
    if (workspaceMode === 'pinned' && !workspacePath) return sendJson(res, 400, { error: 'pinned workspace requires a path' })

    // Validate non-secret config fields against the kind's introspected fields.
    const config = {}
    for (const [name, value] of Object.entries(body.config ?? {})) {
      if (value === undefined || value === null || value === '') continue
      config[name] = value
    }
    for (const field of kindDef.fields) {
      if (field.secret || !field.required) continue
      if (config[field.name] === undefined) return sendJson(res, 400, { error: `missing required field: ${field.name}` })
    }

    const now = new Date().toISOString()
    let record = body.id ? deps.tables.channels.get(String(body.id)) : undefined
    const creating = !record
    if (creating) {
      record = channelSchema.parse({
        id: randomUUID(),
        kind: body.kind,
        label: String(body.label).trim(),
        enabled: true,
        config,
        secretRefs: {},
        workspaceMode,
        workspacePath,
        createdAt: now,
        updatedAt: now,
      })
    } else {
      const restartNeeded = record.kind !== body.kind || record.enabled
      record = {
        ...record,
        label: String(body.label).trim(),
        config,
        workspaceMode,
        workspacePath,
        enabled: record.enabled,
        updatedAt: now,
      }
      void restartNeeded
    }
    record.sessionPolicy = {
      rotationEnabled: body.sessionPolicy?.rotationEnabled !== false,
      contextThresholdPct: Number(body.sessionPolicy?.contextThresholdPct ?? 80),
      handoff: body.sessionPolicy?.handoff === 'summary' ? 'summary' : 'clean',
      archivePrevious: Boolean(body.sessionPolicy?.archivePrevious),
    }

    await applySecrets(record.id, record.secretRefs, body.secrets)
    await deps.tables.channels.put(record.id, record)
    if (record.enabled) {
      await syncChannelToSidecar(sidecar, record, { restart: !creating })
    } else {
      await sidecar.request({ op: 'remove_channel', channel_id: record.id }).catch(() => {})
    }
    ctx.logger.info('dsh-gateway: channel %s (%s) %s', record.id, record.kind, creating ? 'created' : 'updated')
    return sendJson(res, 200, { ok: true, id: record.id })
  }
}
