// Subject routing: (channel, subject) -> DSH session, with context-watermark
// session rotation and built-in routing commands (/model, /workspace).
// One in-flight request per subject; replies read from the session surface
// after the agent reaches quiescence.
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'

export const COMMAND_RE = /^\/(help|new|compact|model|workspace)\b\s*(.*)$/s

export function extractLastAssistantText(snapshot) {
  const events = snapshot?.events ?? []
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'assistant/message') continue
    const message = event.data?.message
    const blocks = message?.content ?? []
    const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('\n').trim()
    if (text) return text
  }
  return null
}

export class Router {
  constructor(ctx, config, tables, dataDir) {
    this.ctx = ctx
    this.config = config
    /** The plugin config's `sessions` shard: routing defaults, not channel state. */
    this.sessionConfig = config?.sessions ?? {}
    this.tables = tables
    // Resolved by the adapter (index.js) from the plugin config, so there is
    // exactly one place that decides where the plugin's data lives. A missing
    // value here is a wiring bug, not a reason to invent a second default.
    if (!dataDir) throw new Error('dsh-gateway: Router requires the resolved data dir')
    this.dataDir = dataDir
    /** routeKey -> route record (domain-backed) */
    this.routes = new Map()
    /** routeKey -> tail promise serializing turns per subject */
    this._chains = new Map()
    /** neutral cwd for unbound channels (resolved lazily, never registered) */
    this._sessionDirPath = null
  }

  async hydrate() {
    for (const [key, record] of this.tables.routes.entries()) this.routes.set(key, record)
    this.ctx.logger.info('dsh-gateway: hydrated %d subject route(s)', this.routes.size)
  }

  routeKey(channelId, subjectId) {
    return `${channelId}:${subjectId}`
  }

  /** Entry point for sidecar inbound frames. Fire-and-forget, serialized per subject. */
  handleInbound(sidecar, payload) {
    const { rid, channel_id: channelId, subject, text } = payload
    const channel = this.tables.channels.get(channelId)
    if (!channel) {
      sidecar.reply(rid, { error: 'channel record missing (removed while message in flight?)' })
      return
    }
    if (!channel.enabled) {
      sidecar.reply(rid, { error: 'channel is disabled' })
      return
    }
    const trimmed = String(text ?? '').trim()
    if (!trimmed) {
      // Media-only inbound: acknowledged with a visible marker (v1 text pipeline).
      sidecar.reply(rid, { events: [{ type: 'MESSAGE', text: '[received non-text content; media support arrives in v2]' }] })
      return
    }
    const command = COMMAND_RE.exec(trimmed)
    if (command) {
      this._handleCommand(sidecar, { rid, channel, subject, cmd: command[1], arg: command[2].trim() })
        .catch((error) => {
          this.ctx.logger.error('dsh-gateway: command /%s failed: %s', command[1], error)
          sidecar.reply(rid, { error: String(error?.message ?? error) })
        })
      return
    }
    const key = this.routeKey(channelId, subject.subject_id)
    const tail = this._chains.get(key) ?? Promise.resolve()
    const run = tail.then(
      () => this._processTurn(sidecar, { rid, channel, subject, text: trimmed, key }),
      () => this._processTurn(sidecar, { rid, channel, subject, text: trimmed, key }),
    )
    this._chains.set(key, run.then(() => {}, () => {}))
  }

  // ------------------------------------------------------------- commands

  /**
   * Built-in routing commands, answered by the bridge without an agent turn.
   * Switch semantics: the override is stored on the route and applied when the
   * next inbound message opens a new session segment (cwd is creation-time
   * fact in DSH); overrides persist across later compactions.
   */
  async _handleCommand(sidecar, { rid, channel, subject, cmd, arg }) {
    const key = this.routeKey(channel.id, subject.subject_id)
    // `let`: a command may have to reserve the route before it exists.
    let route = this.routes.get(key)
    const reply = (text) => sidecar.reply(rid, { events: [{ type: 'MESSAGE', text }] })
    const persist = async () => {
      route.updatedAt = new Date().toISOString()
      await this.tables.routes.put(key, route)
    }

    if (cmd === 'help') {
      return reply([
        '内置命令：',
        '/new — 下一条消息开启新会话',
        '/compact — 立即就地压缩当前会话历史',
        '/model — 查看当前会话模型',
        '/model list — 列出可用模型',
        '/model <序号|模型ID> — 切换模型（下一条消息开启新会话）',
        '/model default — 恢复默认模型',
        '/workspace — 列出这个通道可以使用的工作区',
        '/workspace <序号|名称> — 切换工作区（下一条消息开启新会话）',
        '/workspace default — 恢复通道默认工作区',
      ].join('\n'))
    }

    if (cmd === 'new') {
      if (arg) return reply('用法：/new（不带参数）。')
      if (!route) return reply('还没有会话记录；下一条消息本身就是新会话。')
      if (route.rotateOnNext) return reply(`已标记：下一条消息将开启新会话（第 ${route.generation + 1} 段）。`)
      route.rotateOnNext = true
      await persist()
      return reply(`下一条消息将开启新会话（第 ${route.generation + 1} 段）；当前会话保留。`)
    }

    if (cmd === 'compact') {
      if (arg) return reply('用法：/compact（不带参数）。')
      if (!route) return reply('还没有会话记录，无需压缩。')
      const agent = this.ctx.agents.get(route.sessionId)
      if (!agent) return reply('当前会话不在运行中，先发一条消息再压缩。')
      const engine = this._compactionFor(agent)
      if (!engine?.compactNow) {
        return reply('这个会话取不到压缩服务（宿主平面和它所属的 agent preset 都没有装配），无法压缩。')
      }
      try {
        const controller = new AbortController()
        const result = await engine.compactNow(agent, controller.signal)
        if (!result) return reply('当前没有可压缩的历史。')
        route.lastCompaction = {
          at: new Date().toISOString(),
          shadowedCount: result.shadowedSeqs?.length ?? 0,
          shadowedTokens: result.shadowedTokenCount ?? 0,
        }
        await persist()
        return reply(`已就地压缩 ${route.lastCompaction.shadowedCount} 条历史（约 ${Math.round(route.lastCompaction.shadowedTokens)} tokens），会话继续。`)
      } catch (error) {
        const code = error?.code ?? error?.name ?? ''
        if (code === 'busy') return reply('会话正忙或有排队消息，稍后再试。')
        if (code === 'cancelled' || error?.name === 'AbortError') return reply('压缩已取消。')
        this.ctx.logger.warn('dsh-gateway: /compact failed for %s: %s', key, error)
        return reply(`压缩失败：${String(error?.message ?? error)}`)
      }
    }

    if (cmd === 'model') {
      if (!arg) return reply(await this._modelStatusText(route))
      if (arg === 'list') return reply(await this._modelCatalogText(route))
      // No session yet? Reserve the choice instead of refusing: the first
      // message creates the session and inherits it.
      if (!route) route = await this._reserveRoute(channel, subject)
      if (arg === 'default') {
        if (!route.modelOverride) return reply('当前未设置模型覆盖，已在用默认模型。')
        route.modelOverride = null
        route.rotateOnNext = true
        await persist()
        return reply('已恢复默认模型，下一条消息将开启新会话。')
      }
      // `/model 3` selects the n-th row of the `/model list` output.
      const index = /^\d+$/.test(arg) ? Number.parseInt(arg, 10) : null
      const resolved = index === null
        ? await this._resolveModel(arg)
        : (await this._modelCatalog()).flat[index - 1] ?? null
      if (!resolved) {
        return reply(
          index === null
            ? `未找到模型 ${arg}。发送 /model list 查看可用模型。`
            : `序号 ${arg} 不存在。发送 /model list 查看可用模型。`,
        )
      }
      if (route.modelOverride?.provider === resolved.provider && route.modelOverride?.model === resolved.model) {
        return reply(`已设置为 ${resolved.model}（下次新会话生效，无需重复设置）。`)
      }
      route.modelOverride = { provider: resolved.provider, model: resolved.model }
      route.rotateOnNext = true
      await persist()
      return reply(route.sessionId
        ? `已切换模型为 ${resolved.model}，下一条消息将开启新会话（第 ${route.generation + 1} 段）。`
        : `已记录模型为 ${resolved.model}；第一条消息就会用它建会话。`)
    }

    if (cmd === 'workspace') {
      const scope = this._workspaceScope(channel)
      const workspaces = scope.available
      if (!arg) return reply(await this._workspaceListText(route, workspaces, scope))
      if (!route) route = await this._reserveRoute(channel, subject)
      if (arg === 'default') {
        if (!route.cwdOverride) return reply('当前未设置工作区覆盖，已在通道默认工作区。')
        route.cwdOverride = null
        route.rotateOnNext = true
        await persist()
        return reply('已恢复通道默认工作区，下一条消息将开启新会话。')
      }
      const index = Number.parseInt(arg, 10)
      const workspace = Number.isInteger(index)
        ? workspaces[index - 1]
        : workspaces.find((w) => w.title === arg || w.path === arg)
      if (!workspace) {
        return reply(scope.mode === 'selected'
          ? `未找到可用的工作区 ${arg}。本通道的访问范围限定为 ${workspaces.length} 个已注册工作区，发送 /workspace 查看。`
          : `未找到工作区 ${arg}。发送 /workspace 查看列表（按序号选择）。`)
      }
      if (route.cwdOverride === workspace.path) {
        return reply(`已绑定工作区「${workspace.title}」（下次新会话生效，无需重复设置）。`)
      }
      route.cwdOverride = workspace.path
      route.rotateOnNext = true
      await persist()
      return reply(route.sessionId
        ? `已切换工作区为「${workspace.title}」（${workspace.path}），下一条消息将开启新会话（第 ${route.generation + 1} 段）。`
        : `已记录工作区「${workspace.title}」（${workspace.path}）；第一条消息就会在这里建会话。`)
    }

    return reply(`未知命令 /${cmd}，发送 /help 查看可用命令。`)
  }

  async _modelStatusText(route) {
    const defaults = this.ctx.agentDefaultModel.currentSelection()
    let current = `${defaults.provider}/${defaults.model}（默认）`
    if (route) {
      const agent = this.ctx.agents.get(route.sessionId)
      const header = agent?.session?.requestHeader?.()
      if (header?.config?.model) current = `${header.config.provider}/${header.config.model}`
    }
    const lines = [`当前模型：${current}`]
    if (route?.modelOverride) lines.push(`待生效覆盖：${route.modelOverride.model}（下一条消息开新会话）`)
    if (route?.rotateOnNext && !route.modelOverride) lines.push('（已标记：下一条消息开启新会话）')
    if (route?.lastCompaction) {
      lines.push(`上次压缩：${route.lastCompaction.shadowedCount} 条历史（约 ${Math.round(route.lastCompaction.shadowedTokens)} tokens）`)
    }
    return lines.join('\n')
  }

  /**
   * Live model catalog: every registered provider that still has a non-empty
   * model list. This mirrors what the DSH Web model picker offers
   * (`llm.listProviders()` x `llm.listModels()`), so a provider blanked out by an
   * empty `models: []` patch drops out here exactly as it drops out there.
   */
  async _modelCatalog() {
    const groups = []
    for (const provider of this.ctx.llm.listProviders()) {
      const id = provider.id ?? provider.name ?? String(provider)
      let models = []
      try {
        models = await this.ctx.llm.listModels(id)
      } catch {
        // Adapter without a readable catalog: not selectable from IM.
      }
      const entries = []
      for (const model of models) {
        const modelId = model.id ?? model.name
        if (typeof modelId !== 'string' || !modelId) continue
        entries.push({ provider: id, providerName: provider.name ?? id, model: modelId })
      }
      if (entries.length) groups.push({ id, name: provider.name ?? id, entries })
    }
    return { groups, flat: groups.flatMap((group) => group.entries) }
  }

  async _modelCatalogText(route) {
    const { groups, flat } = await this._modelCatalog()
    if (!groups.length) return '当前没有可用模型（所有 provider 都未启用或没有配置模型）。'
    const lines = ['可用模型（发送 /model <序号> 切换）：']
    let n = 0
    for (const group of groups) {
      lines.push('', `${group.name}（${group.id}）`)
      for (const entry of group.entries) {
        n += 1
        const mark =
          route?.modelOverride?.provider === entry.provider && route?.modelOverride?.model === entry.model
            ? '  ← 待生效'
            : ''
        lines.push(`  ${n}. ${entry.model}${mark}`)
      }
    }
    lines.push('', `共 ${flat.length} 个模型。发送 /model default 恢复默认模型。`)
    return lines.join('\n')
  }

  /** Resolve a user-typed model id to its owning provider route. */
  async _resolveModel(modelId) {
    const providers = this.ctx.llm.listProviders()
    for (const provider of providers) {
      const providerId = provider.id ?? provider.name ?? String(provider)
      try {
        const models = await this.ctx.llm.listModels(providerId)
        if (models.some((m) => (m.id ?? m.name) === modelId)) return { provider: providerId, model: modelId }
      } catch {
        // Adapter without a catalog: fall through to the next provider.
      }
    }
    return null
  }

  /**
   * Which registered workspaces one channel may use, and where its sessions
   * call home.
   *
   * `all` places no restriction: the channel may reach every registered
   * workspace and, with no `/workspace` override, its sessions land in the
   * neutral directory (the sidebar's ungrouped bucket). `selected` is a
   * whitelist of stored paths: only those are listed and selectable, and the
   * first one that is still registered becomes the default location, so a
   * scoped channel has a home instead of quietly landing nowhere. A stored
   * path the registry no longer knows about is still honoured as the home —
   * exactly what the retired pinned binding did — but it never appears in the
   * list.
   */
  _workspaceScope(channel) {
    const registry = this.ctx.workspaceRegistry.list()
    const access = channel?.workspaceAccess
    if (access?.mode !== 'selected') {
      return { mode: 'all', available: registry, home: null, allowed: null }
    }
    const scoped = [...new Set((access.paths ?? []).map((path) => String(path ?? '').trim()).filter(Boolean))]
    const byPath = new Map(registry.map((workspace) => [workspace.path, workspace]))
    return {
      mode: 'selected',
      available: scoped.map((path) => byPath.get(path)).filter(Boolean),
      home: scoped.find((path) => byPath.has(path)) ?? scoped[0] ?? null,
      allowed: new Set(scoped),
    }
  }

  /** Whether a route override is still inside the channel's access scope. */
  _overrideAllowed(scope, cwd) {
    return scope.mode === 'all' || scope.allowed?.has(cwd) === true
  }

  async _workspaceListText(route, workspaces, scope) {
    if (!workspaces.length) {
      return scope?.mode === 'selected'
        ? '本通道的工作区访问范围里没有可用的已注册工作区；请到设置页调整，或让管理员注册工作区。'
        : '还没有已注册的工作区。'
    }
    let currentCwd = route?.cwdOverride ?? null
    if (!currentCwd && route?.sessionId) {
      currentCwd = await this.ctx.sessionQuery
        .readSession(route.sessionId)
        .then((snapshot) => snapshot?.session?.cwd ?? null)
        .catch(() => null)
    }
    const lines = workspaces.map((workspace, i) => {
      const mark = workspace.path === currentCwd ? ' ← 当前' : ''
      return `${i + 1}. ${workspace.title}（${workspace.path}）${mark}`
    })
    const text = ['工作区：', ...lines].join('\n')
    const notes = []
    if (scope?.mode === 'selected') {
      notes.push(`（本通道的访问范围限定为这 ${workspaces.length} 个已注册工作区，会话默认落在第一个）`)
    }
    if (route?.cwdOverride) notes.push('（已设置覆盖；/workspace default 恢复通道默认）')
    return notes.length ? `${text}\n${notes.join('\n')}` : text
  }

  // ----------------------------------------------------------------- turns

  async _processTurn(sidecar, { rid, channel, subject, text, key }) {
    try {
      const previous = this.routes.get(key)
      // A session is replaced only when a command asked for it (/new, /model,
      // /workspace). Context pressure is answered by compacting in place.
      // A route with no session at all (reserved by a command before the first
      // message) is not reusable — it just supplies the overrides.
      const rotateNow = Boolean(previous && previous.rotateOnNext)
      const needsSession = !previous || !previous.sessionId
      let route = rotateNow || needsSession
        ? await this._createSession({ channel, subject, key, previous, rotate: rotateNow })
        : previous

      // Refresh routing metadata from this inbound before any push reuse.
      route.chatType = String(subject.chat_type ?? '')
      route.lastMetadata = subject.metadata ?? {}
      this.routes.set(key, route)
      await this.tables.routes.put(key, route)

      let agent = this.ctx.agents.get(route.sessionId)
      if (!agent) {
        try {
          agent = (await this.ctx.agents.resume({
            resumeSessionId: route.sessionId,
            // Restore the composition the session was created with. A session
            // from before this plugin composed presets records none, so it is
            // upgraded to the deployment default in place — the alternative is
            // leaving it permanently without tools, which no later action could
            // undo (a started session cannot be rebound to a preset).
            setup: async (agentCtx, agent) => {
              const recorded = agent.session?.header?.agentPreset
              if (recorded === undefined) {
                this.ctx.logger.info(
                  'dsh-gateway: session %s records no agent preset (created before composition); composing it with the deployment default',
                  route.sessionId,
                )
              }
              const composition = await this._composePreset(recorded)
              await composition.mount(agentCtx)
            },
          })).agent
        } catch (error) {
          this.ctx.logger.warn('dsh-gateway: resume failed for %s: %s', route.sessionId, error)
        }
      }
      if (!agent) {
        // Session archived or lost: start a fresh generation instead of failing.
        route = await this._createSession({ channel, subject, key, previous: route, rotate: false })
        agent = this.ctx.agents.get(route.sessionId)
      }
      if (!agent) throw new Error('agent unavailable after creation')

      // A session whose header carries no cwd cannot assemble its prompt (the
      // {{cwd}} variable) — e.g. created before the workspace fix. Rotate.
      const header = await this.ctx.sessionQuery
        .readSession(route.sessionId)
        .then((snapshot) => snapshot?.session)
        .catch(() => undefined)
      if (header && !header.cwd) {
        this.ctx.logger.warn('dsh-gateway: session %s has no cwd; rotating', route.sessionId)
        route = await this._createSession({ channel, subject, key, previous: route, rotate: false })
        agent = this.ctx.agents.get(route.sessionId)
      }
      if (!agent) throw new Error('agent unavailable after rotation')

      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      agent.followup(message)

      const timeoutMs = Math.max(30, this.sessionConfig.replyTimeoutSec) * 1000
      let settled = false
      let timer
      try {
        await Promise.race([
          agent.whenIdle().then(() => { settled = true }),
          new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs) }),
        ])
      } finally {
        clearTimeout(timer)
      }
      if (!settled) throw new Error(`agent turn did not settle within ${this.sessionConfig.replyTimeoutSec}s`)

      const snapshot = await this.ctx.sessionQuery.readSurface(route.sessionId)
      const replyText = extractLastAssistantText(snapshot)
      if (!replyText) {
        const turnError = await this._lastTurnError(route.sessionId)
        throw new Error(turnError ?? 'turn finished without assistant text')
      }
      sidecar.reply(rid, { events: [{ type: 'MESSAGE', text: replyText }] })

      // The reply is already on its way; a compaction failure must not turn a
      // delivered answer into an error reply.
      await this._maybeCompact(route, agent, channel)
    } catch (error) {
      this.ctx.logger.error('dsh-gateway: turn for %s failed: %s', key, error)
      sidecar.reply(rid, { error: String(error?.message ?? error) })
    }
  }

  /**
   * Create and persist a route that owns no session yet, so /model and
   * /workspace can be used before the first message. The session created by that
   * first message inherits whatever the route reserved (see `_createSession`),
   * and the route survives a restart because it lives in the same table.
   */
  async _reserveRoute(channel, subject) {
    const key = this.routeKey(channel.id, subject.subject_id)
    const route = {
      key,
      channelId: channel.id,
      subjectId: subject.subject_id,
      sessionId: '',
      generation: 0,
      chatType: String(subject.chat_type ?? ''),
      lastMetadata: subject.metadata ?? {},
      modelOverride: null,
      cwdOverride: null,
      rotateOnNext: false,
      lastCompaction: null,
      updatedAt: new Date().toISOString(),
    }
    this.routes.set(key, route)
    await this.tables.routes.put(key, route)
    this.ctx.logger.info('dsh-gateway: reserved route %s (no session yet)', key)
    return route
  }

  /** Last turn/end error message from the raw session log, for IM replies. */
  async _lastTurnError(sessionId) {
    try {
      const snapshot = await this.ctx.sessionQuery.readSession(sessionId)
      for (let i = snapshot.events.length - 1; i >= 0; i--) {
        const event = snapshot.events[i]
        if (event?.type !== 'turn/end') continue
        const reason = event.data?.reason
        if (reason?.kind === 'error') return String(reason.error?.message ?? 'turn failed')
        return null
      }
      return null
    } catch {
      return null
    }
  }

  async _createSession({ channel, subject, key, previous, rotate }) {
    const sessionId = `session-${randomUUID()}`
    const requestedCwd = previous?.cwdOverride ?? null
    // A /workspace override is honoured only while it is inside the channel's
    // access scope: narrowing the scope in the settings page must evict an
    // override the page no longer allows, not leave it standing.
    const scope = this._workspaceScope(channel)
    let cwdOverride = requestedCwd
    if (requestedCwd && !this._overrideAllowed(scope, requestedCwd)) {
      cwdOverride = null
      this.ctx.logger.warn(
        'dsh-gateway: dropping the /workspace override %s for %s: outside the channel\'s access scope',
        requestedCwd, key,
      )
    }
    const binding = cwdOverride ? { cwd: cwdOverride, bound: true } : await this._resolveBinding(channel)
    const { cwd } = binding
    if (cwd) {
      await mkdir(cwd, { recursive: true }).catch((error) => {
        throw new Error(`failed to ensure workspace directory "${cwd}": ${error}`)
      })
    }
    const override = previous?.modelOverride ?? null
    // Compose the agent the way a GUI session is composed (see `_composePreset`):
    // this is what gives an IM session the deployment's tools, skills and
    // compaction when the deployment keeps them behind agent presets.
    const composition = await this._composePreset(undefined)
    // Do NOT pin a model unless `/model` set an explicit override. An ordinary IM
    // conversation must follow DSH's own default selection — the route the session
    // controller would resolve for a fresh GUI session — instead of a model this
    // plugin chose. `_installFollowDefaultSelection` supplies provider/model through
    // the agent/request waterfall until the session logs a route of its own.
    const handle = await this.ctx.agents.create({
      sessionId,
      agentOptions: override ? { provider: override.provider, model: override.model } : {},
      meta: {
        ...(cwd ? { cwd } : {}),
        // Durable on purpose: it decides this session's tools and prompt, so a
        // resume must restore the same composition.
        ...(composition.agentPreset ? { agentPreset: composition.agentPreset } : {}),
      },
      setup: async (agentCtx, agent) => {
        await composition.mount(agentCtx)
        if (!override) this._installFollowDefaultSelection(agentCtx, agent)
      },
    })
    void handle
    // Account an explicitly bound session under its Workspace, the same membership
    // the built-in session controller records for GUI sessions. An unbound channel
    // is deliberately left unaccounted so its conversation lands in the sidebar's
    // "未分组" bucket even if some Workspace happens to own the neutral directory.
    if (binding.bound) {
      try {
        const workspace = await this.ctx.workspaceRegistry.resolveByPath(cwd)
        if (workspace) await workspace.attachSession(sessionId)
      } catch (error) {
        this.ctx.logger.warn(
          'dsh-gateway: could not attach session %s to workspace %s: %s',
          sessionId, cwd, error,
        )
      }
    }
    const route = {
      key,
      channelId: channel.id,
      subjectId: subject.subject_id,
      sessionId,
      generation: previous ? previous.generation + 1 : 1,
      chatType: String(subject.chat_type ?? ''),
      lastMetadata: subject.metadata ?? {},
      modelOverride: override,
      // The cleaned value, so a dropped out-of-scope override does not come
      // back on the next rotation.
      cwdOverride,
      rotateOnNext: false,
      lastCompaction: null,
      updatedAt: new Date().toISOString(),
    }
    this.routes.set(key, route)
    await this.tables.routes.put(key, route)
    this.ctx.logger.info(
      'dsh-gateway: session %s (gen %d, model %s)%s for %s%s',
      sessionId, route.generation,
      override ? `${override.provider}/${override.model} (/model 覆盖)` : '跟随 DSH 默认选择',
      cwd ? ` @ ${cwd}` : ' (no cwd)', key, rotate ? ' [rotated]' : '',
    )
    if (previous && channel.sessionPolicy.archivePrevious) {
      await this.ctx.workspaceRegistry.archiveSession(previous.sessionId).catch((error) => {
        this.ctx.logger.warn('dsh-gateway: archive of previous session failed: %s', error)
      })
    }
    return route
  }

  /**
   * Resolve where one channel's sessions run, and whether that place is an
   * explicitly bound Workspace.
   *
   * Two configurations bind one: a channel whose workspace scope is
   * `selected`, and the deployment `defaultWorkspacePath`. Everything else gets
   * a neutral working directory that the bridge never registers and never
   * attaches to, so its conversations surface under the sidebar's "未分组"
   * bucket like any other Workspace-less session — the bridge must not invent a
   * Workspace the user did not ask for.
   */
  async _resolveBinding(channel) {
    const scope = this._workspaceScope(channel)
    if (scope.home) return { cwd: scope.home, bound: true }
    if (this.sessionConfig.defaultWorkspacePath) return { cwd: this.sessionConfig.defaultWorkspacePath, bound: true }
    return { cwd: await this._sessionDir(), bound: false }
  }

  /** Neutral cwd for unbound channels: <dataDir>/workspace (never registered). */
  async _sessionDir() {
    if (this._sessionDirPath) return this._sessionDirPath
    const dir = path.join(this.dataDir, 'workspace')
    await mkdir(dir, { recursive: true }).catch((error) => {
      throw new Error(`failed to create the bridge session directory "${dir}": ${error}`)
    })
    this._sessionDirPath = dir
    this.ctx.logger.info('dsh-gateway: unbound sessions run in %s (not a registered workspace)', dir)
    return dir
  }

  /**
   * How one session's capabilities get composed, and which preset to record.
   *
   * A roster deployment (the Web profile) moves every model-facing row — tools,
   * skills, and the compaction backend — behind an agent preset, isolated per
   * preset and mounted per session; the host plane then has none of them, which
   * is exactly what a session created without a preset gets. A preset-free
   * deployment (acp / headless) composes them on the host plane instead.
   *
   * So compose the way the session controller does: resolve the preset (the
   * caller's choice, or the deployment default for a session that records none),
   * hand back its id for the session header, and mount it inside the agent's
   * setup. `mount` is a no-op when this deployment has no roster.
   *
   * A broken or missing preset does NOT take the conversation down with it: IM
   * has no operator watching a log, so the session is composed without a preset
   * (what it would have had before this existed) and the reason is logged once.
   */
  async _composePreset(requested) {
    const presets = this.ctx.get('agentPresets')
    if (!presets) return { agentPreset: undefined, mount: async () => {} }
    let id
    try {
      const resolved = await presets.resolve(requested)
      if (resolved.broken !== undefined) {
        this._warnPresetOnce(resolved.id, resolved.broken)
        return { agentPreset: undefined, mount: async () => {} }
      }
      id = resolved.id
    } catch (error) {
      this._warnPresetOnce(requested ?? '(部署默认)', String(error?.message ?? error))
      return { agentPreset: undefined, mount: async () => {} }
    }
    return {
      agentPreset: id,
      mount: async (agentCtx) => {
        // A race between resolve and mount would otherwise leave the header
        // naming a preset the agent does not have; let it fail the session
        // instead of publishing that inconsistency.
        await presets.mount(agentCtx, id)
      },
    }
  }

  _warnPresetOnce(id, reason) {
    this.ctx.logger.warn(
      'dsh-gateway: agent preset %s is unusable (%s); this session is composed without one, so it gets only the host-plane tools',
      id, reason,
    )
  }

  /**
   * The compaction engine that would act on ONE agent.
   *
   * A roster deployment publishes it inside the session's agent preset, behind
   * that preset's own isolate realm — the mount is deliberately not under the
   * agent's fiber, so neither `agent.ctx.get` nor this plugin's own `ctx.get`
   * reaches it. The registry's read addressing is the way in (it is what the
   * session controller and the subagent runtime use for preset-scoped services).
   * A preset-free deployment publishes the engine on the host plane.
   */
  _compactionFor(agent) {
    const presets = this.ctx.get('agentPresets')
    if (presets && agent) {
      const scoped = presets.serviceFor(agent, 'compaction')
      if (scoped?.compactNow) return scoped
    }
    return this.ctx.get('compaction')
  }

  /**
   * Supply provider/model the way DSH's own session controller does for a session
   * the user never explicitly routed: the session's own logged route once it has
   * one, otherwise the current default selection (which the model picker keeps in
   * sync with the last choice). Nothing is pinned here, so an ordinary IM session
   * simply follows the same model a fresh GUI session would.
   */
  _installFollowDefaultSelection(agentCtx, agent) {
    // These listeners live on the AGENT's context, and the agent outlives this
    // plugin's context on purpose (disabling the gateway must not kill the
    // sessions it created) — so this closure can outlive it too. Reading an
    // injected service off a disposed context throws (`... in inactive context`)
    // and a surviving session's turn must not die for that: with no live
    // default to read, the session simply gets no route opinion from here.
    const defaults = () => {
      try {
        return this.ctx.agentDefaultModel?.currentSelection()
      } catch {
        return undefined
      }
    }
    installModelSelection(agentCtx, {
      get current() {
        const logged = agent.session.requestHeader()
        if (logged === undefined) return defaults()
        const config = logged.config
        const inheritedEffort = logged.adapterDefaults?.reasoningEffort === true
        return {
          provider: config.provider,
          model: config.model,
          ...(config.reasoningEffort === undefined || inheritedEffort
            ? {}
            : { reasoningEffort: config.reasoningEffort }),
        }
      },
      set current(_next) {},
      assembled: undefined,
    })
  }

  /**
   * The routed model for a session: the session's own logged route once it has
   * one, otherwise the agent's creation options, otherwise the current default.
   * Reading the logged header matters because a session that follows DSH's
   * default selection carries no `agent.options` — its route is supplied through
   * the request waterfall — and the context window must not be guessed.
   */
  _routedTarget(agent) {
    const logged = agent?.session?.requestHeader?.()?.config
    if (logged?.provider && logged?.model) return { provider: logged.provider, model: logged.model }
    if (agent?.options?.provider && agent?.options?.model) {
      return { provider: agent.options.provider, model: agent.options.model }
    }
    const fallback = this.ctx.agentDefaultModel?.currentSelection?.()
    if (fallback?.provider && fallback?.model) return { provider: fallback.provider, model: fallback.model }
    return null
  }

  /** The model's context window, or null when the adapter declares none. */
  async _contextWindow(agent) {
    const target = this._routedTarget(agent)
    if (!target) return null
    try {
      const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model)
      return info?.contextWindow ?? null
    } catch (error) {
      this.ctx.logger.warn('dsh-gateway: resolveModelInfo(%s/%s) failed: %s', target.provider, target.model, error)
      return null
    }
  }

  /**
   * Reduce a filling session IN PLACE once the channel's threshold is crossed —
   * the session continues, so the conversation is not interrupted. The bridge
   * owns only the decision: `compactNow` picks a safe balanced range, retains
   * what the host's policy says, writes the summary and commits the durable
   * transaction. The host may run its own pressure compaction as well; both
   * reduce the same history, and neither replaces the session.
   *
   * Never throws: the turn has already been answered, so a failed or racing
   * compaction is a log line and a stored state, not a user-visible failure.
   */
  async _maybeCompact(route, agent, channel) {
    const policy = channel.sessionPolicy ?? {}
    if (policy.compactEnabled === false) return
    const thresholdPct = Number(policy.compactThresholdPct ?? 80)
    // The engine belongs to the session, not to this plugin: a roster deployment
    // publishes it inside the session's agent preset, a preset-free one on the
    // host plane. A deployment with neither leaves the plugin working, so a
    // missing engine is a silent return, not an error.
    const engine = this._compactionFor(agent)
    if (!engine?.compactNow) return
    try {
      const session = this.ctx.sessions.get(route.sessionId)
      if (!session) return
      const measurement = this.ctx.tokenMeter.measure(session)
      if (!(measurement.totalTokens > 0)) return
      const contextWindow = await this._contextWindow(agent)
      if (!contextWindow) return
      const usedPct = (measurement.totalTokens * 100) / contextWindow
      if (usedPct < thresholdPct) return
      // `compactNow` reserves idle admission itself and throws `busy` when the
      // agent is not idle; a second inbound message may have arrived meanwhile.
      const controller = new AbortController()
      const result = await engine.compactNow(agent, controller.signal)
      if (!result) {
        this.ctx.logger.info(
          'dsh-gateway: route %s at %.1f%% >= %d%% but no compactable history',
          route.key, usedPct, thresholdPct,
        )
        return
      }
      route.lastCompaction = {
        at: new Date().toISOString(),
        shadowedCount: result.shadowedSeqs?.length ?? 0,
        shadowedTokens: result.shadowedTokenCount ?? 0,
      }
      route.updatedAt = new Date().toISOString()
      this.routes.set(route.key, route)
      await this.tables.routes.put(route.key, route)
      this.ctx.logger.info(
        'dsh-gateway: route %s compacted in place (%d/%d tokens, %.1f%% >= %d%%): %d history item(s), ~%d tokens',
        route.key, measurement.totalTokens, contextWindow, usedPct, thresholdPct,
        route.lastCompaction.shadowedCount, route.lastCompaction.shadowedTokens,
      )
    } catch (error) {
      const code = error?.code ?? ''
      if (code === 'busy') {
        this.ctx.logger.info('dsh-gateway: compaction for %s skipped, agent busy', route.key)
        return
      }
      this.ctx.logger.warn('dsh-gateway: compaction for %s failed: %s', route.key, error)
    }
  }
}
