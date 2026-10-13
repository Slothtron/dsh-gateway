// dsh-gateway Host half.
// Owns: the Python sidecar process, the channel/route storage domain, subject
// routing with rotation, the /api/dsh-gateway HTTP control surface, and the
// im_list_channels / im_push_text tools. The Client half (client.js) renders
// the settings page.
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { gatewayDomainName, openTables } from './lib/domain.mjs'
import { profileScope } from './lib/scope.mjs'
import { Sidecar } from './lib/sidecar.mjs'
import { RuntimeManager } from './lib/runtime.mjs'
import { Router } from './lib/router.mjs'
import { registerRoutes } from './lib/http.mjs'
import { registerTools } from './lib/tools.mjs'

export const name = 'dsh-gateway'

export const inject = [
  'tools',
  'webServer',
  'agents',
  'sessions',
  'tokenMeter',
  'llm',
  'credentials',
  'storageDomain',
  'workspaceRegistry',
  'sessionQuery',
  'agentDefaultModel',
  'timer',
]

/**
 * Plugin config, sharded by capability. `runtime` is how the Python sidecar is
 * resolved and provisioned; `sessions` is where a channel's conversations live
 * and how long one turn may take. Channel-level settings (per-platform fields,
 * workspace access, compaction policy) are NOT here: they live on the channel
 * record and are edited on the settings page.
 *
 * Every key here also appears in cordis.patch.yml (the defaults layer) and in
 * README.md's table; `config-surface.test.mjs` fails when the three drift apart.
 */
export const Config = Schema.object({
  runtime: Schema.object({
    pythonBin: Schema.string().role('text').default('').description(
      'Explicit Python interpreter for the sidecar; non-empty = use only this one, skip every probe and every install',
    ),
    pythonRuntime: Schema.union([
      Schema.const('auto'),
      Schema.const('system'),
      Schema.const('managed'),
    ]).default('auto').description(
      'auto = probe <package>/.venv, then python3/python, then install a managed venv; system = probe the system interpreters only, never install; managed = use <dataDir>/runtime/venv only',
    ),
    pipIndexUrl: Schema.string().role('text').default('').description(
      'Package index for the managed-venv install, used only while installing (empty = pip default; set it for an internal mirror)',
    ),
    gatewayVersion: Schema.string().role('text').default('').description(
      'Requirement suffix for octop-gateway in the managed venv, e.g. "==1.0.0", used only while installing (empty = latest)',
    ),
    dataDir: Schema.string().role('text').default('').description(
      'Sidecar data dir: managed runtime, media storage, scratch, and the neutral session dir <dataDir>/workspace; empty = <DSH_HOME>/dsh-gateway (default ~/.dsh/dsh-gateway)',
    ),
  }),
  sessions: Schema.object({
    defaultWorkspacePath: Schema.string().role('text').default('').description(
      'Workspace for a channel whose access scope is unrestricted and which has no /workspace override; empty = unbound, sessions run in <dataDir>/workspace and are not registered as a workspace',
    ),
    replyTimeoutSec: Schema.number().default(240).description(
      'Seconds to wait for one agent turn to settle before replying an error to the IM channel; floor is 30',
    ),
  }),
})

/** Top-level keys of the pre-shard flat config, where they moved. */
const RETIRED_CONFIG_KEYS = new Map([
  ['pythonBin', 'runtime.pythonBin'],
  ['pythonRuntime', 'runtime.pythonRuntime'],
  ['pipIndexUrl', 'runtime.pipIndexUrl'],
  ['gatewayVersion', 'runtime.gatewayVersion'],
  ['dataDir', 'runtime.dataDir'],
  ['defaultWorkspacePath', 'sessions.defaultWorkspacePath'],
  ['replyTimeoutSec', 'sessions.replyTimeoutSec'],
])

export async function apply(ctx, config) {
  // The schema keeps unknown keys, so a config copied from an older version
  // would load and then be ignored field by field — the deployment would run on
  // defaults while its file says otherwise. Fail loud instead, with the path.
  const retired = [...RETIRED_CONFIG_KEYS.keys()].filter((key) => key in config)
  if (retired.length > 0) {
    const moved = retired.map((key) => `config.${key} → config.${RETIRED_CONFIG_KEYS.get(key)}`).join('; ')
    throw new Error(`dsh-gateway: invalid_config — this config is flat; the keys moved: ${moved}`)
  }
  // The configuration is profile-scoped: this token names the storage unit this
  // activation reads and writes (`dsh_gateway_web`), so another profile's channels
  // are not here to conflict with.
  const { scope, profile } = profileScope(ctx)
  ctx.logger.info(
    'dsh-gateway: profile %s → storage unit %s',
    profile ?? '(unknown — no profile identity, using the plain unit)', gatewayDomainName(scope),
  )
  const packageDir = path.dirname(fileURLToPath(import.meta.url))
  const scriptPath = path.join(packageDir, 'sidecar', 'dsh_gateway_sidecar.py')
  const runtimeConfig = config.runtime ?? {}
  // Under DSH_HOME, so a deployment that relocates its home keeps the plugin's
  // state beside the storages and sessions it belongs to (house pattern: the
  // host's own stores resolve their paths the same way).
  const dataDir = runtimeConfig.dataDir?.trim() ? runtimeConfig.dataDir.trim() : dshHomePath('dsh-gateway')
  await mkdir(dataDir, { recursive: true }).catch((error) => {
    ctx.logger.warn('dsh-gateway: failed to create data dir %s: %s', dataDir, error)
  })
  // The sidecar needs a Python interpreter that imports octop_gateway. Resolve
  // one (or provision a managed venv under the data dir) before every start.
  const runtime = new RuntimeManager({
    ctx,
    mode: runtimeConfig.pythonRuntime,
    explicitBin: runtimeConfig.pythonBin,
    packageDir,
    dataDir,
    pipIndexUrl: runtimeConfig.pipIndexUrl,
    gatewayVersion: runtimeConfig.gatewayVersion,
  })

  const tables = await openTables(ctx, scope)
  const router = new Router(ctx, config, tables, dataDir)
  await router.hydrate()

  const state = {
    kinds: null,
    drift: [],
    status: new Map(),
    gatewayVersion: null,
    startedAt: null,
    lastError: null,
    runtime: runtime.status,
  }

  /**
   * Record why one channel is (not) up. The sidecar reports what it can see of a
   * channel it holds; only this half knows about the ones it never handed over
   * (a disabled record, a kind the catalogue dropped, a registration that threw),
   * so those reasons are set here and survive the next status frame.
   */
  const setStatus = (channelId, patch) => {
    if (!channelId) return
    const previous = state.status.get(channelId) ?? {}
    state.status.set(channelId, {
      connected: false,
      reason: null,
      detail: null,
      ...previous,
      ...patch,
      updatedAt: new Date().toISOString(),
    })
  }

  const applyStatus = (frame) => {
    for (const entry of frame.channels ?? []) {
      const connected = Boolean(entry.connected)
      setStatus(entry.channel_id, {
        connected,
        // The sidecar names the state; a frame from an older sidecar carries no
        // reason, which only costs the page its wording, not its truth.
        reason: entry.reason ?? (connected ? 'running' : 'connecting'),
        detail: entry.detail ?? null,
      })
    }
  }

  const sidecar = new Sidecar(ctx, {
    pythonBin: null, // set from the resolved runtime before each start
    scriptPath,
    dataDir,
    onInbound: (frame) => router.handleInbound(sidecar, frame),
    onStatus: applyStatus,
    onExit: null, // assigned below
  })

  /** The kinds this deployment offers, from the channel catalogue. */
  const supportedKinds = () => new Set((state.kinds ?? []).map((entry) => entry.kind))

  async function replayChannels() {
    const supported = supportedKinds()
    for (const [id, record] of tables.channels.entries()) {
      if (!record.enabled) {
        setStatus(id, { connected: false, reason: 'disabled', detail: null })
        continue
      }
      if (!supported.has(record.kind)) {
        // The catalogue narrowed: keep the record, do not start it, and say so
        // once per boot rather than failing the whole replay.
        ctx.logger.warn(
          'dsh-gateway: channel %s (%s) is configured but this deployment no longer offers that kind; not started',
          id, record.kind,
        )
        setStatus(id, { connected: false, reason: 'unsupported', detail: null })
        continue
      }
      try {
        const secrets = {}
        for (const [field, ref] of Object.entries(record.secretRefs ?? {})) {
          const resolved = await ctx.credentials.resolve(ref).catch(() => undefined)
          if (resolved?.value) secrets[field] = resolved.value
        }
        await sidecar.request({
          op: 'add_channel',
          channel_id: id,
          kind: record.kind,
          config: record.config,
          secrets,
        })
        ctx.logger.info('dsh-gateway: replayed channel %s (%s)', id, record.kind)
      } catch (error) {
        ctx.logger.error('dsh-gateway: replay of channel %s failed: %s', id, error)
        state.lastError = `channel ${record.label} (${record.kind}) failed to start: ${error}`
        setStatus(id, {
          connected: false,
          reason: 'error',
          detail: String(error?.message ?? error),
        })
      }
    }
  }

  let restartDelayMs = 2_000
  let restartDisposer = null
  let stopping = false

  async function startSidecar() {
    state.lastError = null
    // Resolution (and a first-activation install) happens here rather than at
    // activation time so a slow or failed install never blocks the host boot.
    const resolved = await runtime.ensure()
    state.runtime = runtime.status
    if (sidecar.pythonBin !== resolved.bin) {
      ctx.logger.info('dsh-gateway: sidecar interpreter %s (%s)', resolved.bin, resolved.kind)
      sidecar.pythonBin = resolved.bin
    }
    await sidecar.start()
    state.startedAt = new Date().toISOString()
    state.gatewayVersion = sidecar.lastHello?.gateway_version ?? null
    const intro = await sidecar.request({ op: 'introspect' }, 30_000)
    state.kinds = intro.kinds ?? []
    state.drift = intro.drift ?? []
    for (const problem of state.drift) {
      ctx.logger.warn('dsh-gateway: channel catalogue drift — %s', problem)
    }
    applyStatus({ channels: [] })
    // Where a session's compaction engine lives is the deployment's decision: a
    // roster deployment composes it inside each agent preset and mounts it per
    // session, a preset-free one publishes it on the host plane. Neither is
    // required — say which case this is instead of discovering it per message.
    if (ctx.get('agentPresets')) {
      ctx.logger.info(
        'dsh-gateway: agent presets are composed; each IM session mounts the deployment default and resolves its services (compaction included) from that preset',
      )
    } else if (!ctx.get('compaction')?.compactNow) {
      ctx.logger.warn(
        'dsh-gateway: no agent presets and no host-plane compaction service composed; per-channel context compaction will not act',
      )
    }
    await replayChannels()
    ctx.logger.info(
      'dsh-gateway: sidecar up (octop-gateway %s, %d kinds, %d channels)',
      state.gatewayVersion, state.kinds.length, tables.channels.size,
    )
  }

  function scheduleRestart(reason) {
    if (stopping) return
    state.lastError = reason
    state.runtime = runtime.status
    ctx.logger.warn('dsh-gateway: %s; restarting sidecar in %dms', reason, restartDelayMs)
    restartDisposer?.()
    restartDisposer = ctx.setTimeout(() => {
      restartDisposer = null
      restartDelayMs = Math.min(restartDelayMs * 2, 30_000)
      startSidecar().catch((error) => {
        ctx.logger.error('dsh-gateway: sidecar restart failed: %s', error)
        scheduleRestart(`sidecar restart failed: ${error}`)
      })
    }, restartDelayMs)
  }

  sidecar.onExit = (code, signal) => {
    scheduleRestart(`sidecar exited unexpectedly (code ${code ?? signal})`)
  }

  /** Re-probe the Python runtime, rebuilding the managed venv, then restart. */
  function bootstrapRuntime() {
    restartDelayMs = 2_000
    runtime.reset({ rebuild: true })
    state.runtime = runtime.status
    state.lastError = null
    return (async () => {
      await sidecar.stop().catch(() => {})
      state.status.clear()
      await startSidecar()
    })().catch((error) => {
      ctx.logger.error('dsh-gateway: runtime bootstrap failed: %s', error)
      state.lastError = String(error?.message ?? error)
      state.runtime = runtime.status
      scheduleRestart(`runtime bootstrap failed: ${error}`)
      throw error
    })
  }

  const deps = {
    ctx,
    config,
    tables,
    sidecar,
    router,
    state,
    runtime,
    scriptPath,
    setStatus,
    restartSidecar: async () => {
      restartDelayMs = 2_000
      await sidecar.stop().catch(() => {})
      state.status.clear()
      await startSidecar()
    },
    bootstrapRuntime,
  }

  registerRoutes(ctx, deps)
  registerTools(ctx, deps)

  // Off the activation path on purpose: the first activation may have to create
  // a venv and install octop-gateway, which must not hold the host boot.
  let startupDisposer = null
  startupDisposer = ctx.setTimeout(() => {
    startupDisposer = null
    startSidecar().catch((error) => {
      ctx.logger.error('dsh-gateway: initial sidecar start failed: %s', error)
      state.lastError = String(error?.message ?? error)
      state.runtime = runtime.status
      scheduleRestart(`initial sidecar start failed: ${error}`)
    })
  }, 0)

  // The callback below runs at ACTIVATION — cordis collects its return value as
  // the disposer — so `stopping` may only be set inside the disposer. Setting it
  // in the setup body disarmed the sidecar's own crash-restart path for the
  // whole life of every activation.
  ctx.effect(() => async () => {
    stopping = true
    startupDisposer?.()
    restartDisposer?.()
    // Finish the shutdown before the host reports the plugin disabled: the next
    // activation spawns a new process, and two sidecars must not poll one IM
    // account.
    await sidecar.stop().catch((error) => ctx.logger.warn('dsh-gateway: sidecar stop failed: %s', error))
  }, 'dsh-gateway.lifecycle')
}
