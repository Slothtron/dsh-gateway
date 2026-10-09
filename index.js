// dsh-gateway Host half.
// Owns: the Python sidecar process, the channel/route storage domain, subject
// routing with rotation, the /api/dsh-gateway HTTP control surface, and the
// im_list_channels / im_push_text tools. The Client half (client.js) renders
// the settings page.
import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { openTables } from './lib/domain.mjs'
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

export const Config = Schema.object({
  pythonBin: Schema.string().role('text').default('').description(
    'Explicit Python interpreter for the sidecar; empty = probe <package>/.venv, python3/python on PATH, then the managed venv',
  ),
  pythonRuntime: Schema.union([
    Schema.const('auto'),
    Schema.const('system'),
    Schema.const('managed'),
  ]).default('auto').description(
    'auto = use any interpreter that already imports octop_gateway, else install a managed venv; system = never install; managed = only the managed venv',
  ),
  pipIndexUrl: Schema.string().role('text').default('').description(
    'Package index for the managed-venv install (empty = pip default; set it for an internal mirror)',
  ),
  gatewayVersion: Schema.string().role('text').default('').description(
    'pip requirement suffix for octop-gateway in the managed venv, e.g. "==1.0.0" (empty = latest)',
  ),
  dataDir: Schema.string().role('text').default('').description(
    'Sidecar data dir (managed Python runtime, media storage, scratch); empty = ~/.dsh/dsh-gateway',
  ),
  defaultWorkspacePath: Schema.string().role('text').default('').description(
    'Workspace directory for channels in "default" mode; empty = unbound, sessions land in the sidebar\'s Ungrouped bucket',
  ),
  replyTimeoutSec: Schema.number().default(240).description(
    'Seconds to wait for an agent turn before replying an error to the IM channel',
  ),
})

export async function apply(ctx, config) {
  const packageDir = path.dirname(fileURLToPath(import.meta.url))
  const scriptPath = path.join(packageDir, 'sidecar', 'dsh_gateway_sidecar.py')
  const dataDir = config.dataDir?.trim()
    ? config.dataDir.trim()
    : path.join(os.homedir(), '.dsh', 'dsh-gateway')
  await mkdir(dataDir, { recursive: true }).catch((error) => {
    ctx.logger.warn('dsh-gateway: failed to create data dir %s: %s', dataDir, error)
  })
  // The sidecar needs a Python interpreter that imports octop_gateway. Resolve
  // one (or provision a managed venv under the data dir) before every start.
  const runtime = new RuntimeManager({
    ctx,
    mode: config.pythonRuntime,
    explicitBin: config.pythonBin,
    packageDir,
    dataDir,
    pipIndexUrl: config.pipIndexUrl,
    gatewayVersion: config.gatewayVersion,
  })

  const tables = await openTables(ctx)
  const router = new Router(ctx, config, tables, dataDir)
  await router.hydrate()

  const state = {
    kinds: null,
    status: new Map(),
    gatewayVersion: null,
    startedAt: null,
    lastError: null,
    runtime: runtime.status,
  }

  const applyStatus = (frame) => {
    for (const entry of frame.channels ?? []) {
      state.status.set(entry.channel_id, { connected: Boolean(entry.connected) })
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

  async function replayChannels() {
    for (const [id, record] of tables.channels.entries()) {
      if (!record.enabled) continue
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
    applyStatus({ channels: [] })
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

  ctx.effect(() => {
    stopping = true
    return () => {
      startupDisposer?.()
      restartDisposer?.()
      sidecar.stop().catch((error) => ctx.logger.warn('dsh-gateway: sidecar stop failed: %s', error))
    }
  })
}
