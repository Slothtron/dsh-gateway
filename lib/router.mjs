// Subject routing: (channel, subject) -> DSH session, with context-watermark
// session rotation and built-in routing commands (/model, /workspace).
// One in-flight request per subject; replies read from the session surface
// after the agent reaches quiescence.
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'

const COMMAND_RE = /^\/(help|model|workspace)\b\s*(.*)$/s

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
    this.tables = tables
    this.dataDir = dataDir ?? path.join(os.homedir(), '.dsh', 'dsh-gateway')
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
   * fact in DSH); overrides persist across later watermark rotations.
   */
  async _handleCommand(sidecar, { rid, channel, subject, cmd, arg }) {
    const key = this.routeKey(channel.id, subject.subject_id)
    const route = this.routes.get(key)
    const reply = (text) => sidecar.reply(rid, { events: [{ type: 'MESSAGE', text }] })
    const persist = async () => {
      route.updatedAt = new Date().toISOString()
      await this.tables.routes.put(key, route)
    }

    if (cmd === 'help') {
      return reply([
        '内置命令：',
        '/model — 查看当前会话模型',
        '/model list — 列出可用模型',
        '/model <序号|模型ID> — 切换模型（下一条消息开启新会话）',
        '/model default — 恢复默认模型',
        '/workspace — 列出工作区',
        '/workspace <序号> — 切换到指定工作区（下一条消息开启新会话）',
        '/workspace default — 恢复通道默认工作区',
      ].join('\n'))
    }

    if (cmd === 'model') {
      if (!arg) return reply(await this._modelStatusText(route))
      if (arg === 'list') return reply(await this._modelCatalogText(route))
      if (!route) return reply('还没有会话记录；先发一条消息建立会话，再使用 /model 切换。')
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
      return reply(`已切换模型为 ${resolved.model}，下一条消息将开启新会话（第 ${route.generation + 1} 段）。`)
    }

    if (cmd === 'workspace') {
      const workspaces = this.ctx.workspaceRegistry.list()
      if (!arg) return reply(await this._workspaceListText(route, workspaces))
      if (!route) return reply('还没有会话记录；先发一条消息建立会话，再使用 /workspace 切换。')
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
      if (!workspace) return reply(`未找到工作区 ${arg}。发送 /workspace 查看列表（按序号选择）。`)
      if (route.cwdOverride === workspace.path) {
        return reply(`已绑定工作区「${workspace.title}」（下次新会话生效，无需重复设置）。`)
      }
      route.cwdOverride = workspace.path
      route.rotateOnNext = true
      await persist()
      return reply(`已切换工作区为「${workspace.title}」（${workspace.path}），下一条消息将开启新会话（第 ${route.generation + 1} 段）。`)
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

  async _workspaceListText(route, workspaces) {
    if (!workspaces.length) return '还没有已注册的工作区。'
    let currentCwd = route?.cwdOverride ?? null
    if (!currentCwd && route) {
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
    if (route?.cwdOverride) return `${text}\n（已设置覆盖；/workspace default 恢复通道默认）`
    return text
  }

  // ----------------------------------------------------------------- turns

  async _processTurn(sidecar, { rid, channel, subject, text, key }) {
    try {
      const previous = this.routes.get(key)
      const rotateNow = Boolean(previous && (previous.rotateOnNext || (previous.rotatable && channel.sessionPolicy.rotationEnabled)))
      let route = rotateNow || !previous
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
          agent = (await this.ctx.agents.resume({ resumeSessionId: route.sessionId })).agent
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

      const timeoutMs = Math.max(30, this.config.replyTimeoutSec) * 1000
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
      if (!settled) throw new Error(`agent turn did not settle within ${this.config.replyTimeoutSec}s`)

      const snapshot = await this.ctx.sessionQuery.readSurface(route.sessionId)
      const replyText = extractLastAssistantText(snapshot)
      if (!replyText) {
        const turnError = await this._lastTurnError(route.sessionId)
        throw new Error(turnError ?? 'turn finished without assistant text')
      }
      sidecar.reply(rid, { events: [{ type: 'MESSAGE', text: replyText }] })

      if (channel.sessionPolicy.rotationEnabled) await this._maybeMarkRotatable(route, agent, channel)
    } catch (error) {
      this.ctx.logger.error('dsh-gateway: turn for %s failed: %s', key, error)
      sidecar.reply(rid, { error: String(error?.message ?? error) })
    }
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
    const cwdOverride = previous?.cwdOverride ?? null
    const binding = cwdOverride ? { cwd: cwdOverride, bound: true } : await this._resolveBinding(channel)
    const { cwd } = binding
    if (cwd) {
      await mkdir(cwd, { recursive: true }).catch((error) => {
        throw new Error(`failed to ensure workspace directory "${cwd}": ${error}`)
      })
    }
    const override = previous?.modelOverride ?? null
    // Do NOT pin a model unless `/model` set an explicit override. An ordinary IM
    // conversation must follow DSH's own default selection — the route the session
    // controller would resolve for a fresh GUI session — instead of a model this
    // plugin chose. `_installFollowDefaultSelection` supplies provider/model through
    // the agent/request waterfall until the session logs a route of its own.
    const handle = await this.ctx.agents.create({
      sessionId,
      agentOptions: override ? { provider: override.provider, model: override.model } : {},
      meta: cwd ? { cwd } : {},
      ...(override ? {} : { setup: (agentCtx, agent) => this._installFollowDefaultSelection(agentCtx, agent) }),
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
      rotatable: false,
      chatType: String(subject.chat_type ?? ''),
      lastMetadata: subject.metadata ?? {},
      modelOverride: override,
      cwdOverride: previous?.cwdOverride ?? null,
      rotateOnNext: false,
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
   * Only two configurations bind one: a pinned channel path and the deployment
   * `defaultWorkspacePath`. An unbound channel gets a neutral working directory
   * that the bridge never registers and never attaches to, so its conversations
   * surface under the sidebar's "未分组" bucket like any other Workspace-less
   * session — the bridge must not invent a Workspace the user did not ask for.
   */
  async _resolveBinding(channel) {
    if (channel.workspaceMode === 'pinned' && channel.workspacePath) {
      return { cwd: channel.workspacePath, bound: true }
    }
    if (this.config.defaultWorkspacePath) return { cwd: this.config.defaultWorkspacePath, bound: true }
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
   * Supply provider/model the way DSH's own session controller does for a session
   * the user never explicitly routed: the session's own logged route once it has
   * one, otherwise the current default selection (which the model picker keeps in
   * sync with the last choice). Nothing is pinned here, so an ordinary IM session
   * simply follows the same model a fresh GUI session would.
   */
  _installFollowDefaultSelection(agentCtx, agent) {
    const defaults = () => this.ctx.agentDefaultModel.currentSelection()
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

  async _maybeMarkRotatable(route, agent, channel) {
    try {
      const session = this.ctx.sessions.get(route.sessionId)
      if (!session) return
      const measurement = this.ctx.tokenMeter.measure(session)
      const provider = agent.options?.provider
      const model = agent.options?.model
      let contextWindow = 262_144
      if (provider && model) {
        const info = await this.ctx.llm.resolveModelInfo(provider, model)
        if (info?.contextWindow) contextWindow = info.contextWindow
      }
      const thresholdPct = channel.sessionPolicy.contextThresholdPct
      const usedPct = contextWindow > 0 ? (measurement.totalTokens * 100) / contextWindow : 0
      if (measurement.totalTokens > 0 && usedPct >= thresholdPct && !route.rotatable) {
        route.rotatable = true
        route.updatedAt = new Date().toISOString()
        this.routes.set(route.key, route)
        await this.tables.routes.put(route.key, route)
        this.ctx.logger.info(
          'dsh-gateway: route %s marked rotatable (%d/%d tokens, %.1f%% >= %d%%)',
          route.key, measurement.totalTokens, contextWindow, usedPct, thresholdPct,
        )
      }
    } catch (error) {
      this.ctx.logger.warn('dsh-gateway: rotation watermark check failed: %s', error)
    }
  }
}
