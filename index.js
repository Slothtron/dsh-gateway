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
import { Sidecar, resolvePythonBin } from './lib/sidecar.mjs'
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
]

export const Config = Schema.object({
  pythonBin: Schema.string().role('text').default('').description(
    'Python interpreter with octop-gateway installed; empty = <package>/.venv/bin/python if present, else python3',
  ),
  dataDir: Schema.string().role('text').default('').description(
    'Sidecar data dir (media storage, scratch); empty = ~/.dsh/dsh-gateway',
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
  const pythonBin = resolvePythonBin(config.pythonBin, packageDir)
  const dataDir = config.dataDir?.trim()
    ? config.dataDir.trim()
    : path.join(os.homedir(), '.dsh', 'dsh-gateway')
  await mkdir(dataDir, { recursive: true }).catch((error) => {
    ctx.logger.warn('dsh-gateway: failed to create data dir %s: %s', dataDir, error)
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
  }

  const applyStatus = (frame) => {
    for (const entry of frame.channels ?? []) {
      state.status.set(entry.channel_id, { connected: Boolean(entry.connected) })
    }
  }

  const sidecar = new Sidecar(ctx, {
    pythonBin,
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

  const deps = {
    ctx,
    config,
    tables,
    sidecar,
    router,
    state,
    pythonBin,
    scriptPath,
    restartSidecar: async () => {
      restartDelayMs = 2_000
      await sidecar.stop().catch(() => {})
      state.status.clear()
      await startSidecar()
    },
  }

  registerRoutes(ctx, deps)
  registerTools(ctx, deps)

  const startError = await startSidecar().then(() => null, (error) => error)
  if (startError) {
    ctx.logger.error('dsh-gateway: initial sidecar start failed: %s', startError)
    state.lastError = String(startError?.message ?? startError)
    scheduleRestart(`initial sidecar start failed: ${startError}`)
  }

  ctx.effect(() => {
    stopping = true
    return () => {
      restartDisposer?.()
      sidecar.stop().catch((error) => ctx.logger.warn('dsh-gateway: sidecar stop failed: %s', error))
    }
  })
}
