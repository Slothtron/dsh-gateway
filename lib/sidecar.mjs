// Sidecar process management: spawn the Python octop-gateway bridge over
// NDJSON stdio, correlate request/response by mid, forward inbound + status.
import { spawn } from 'node:child_process'

const REQUEST_TIMEOUT_MS = 30_000

export class Sidecar {
  constructor(ctx, { pythonBin, scriptPath, dataDir, onInbound, onStatus, onExit }) {
    this.ctx = ctx
    this.pythonBin = pythonBin
    this.scriptPath = scriptPath
    this.dataDir = dataDir
    this.onInbound = onInbound
    this.onStatus = onStatus
    this.onExit = onExit
    this.proc = null
    this.lastHello = null
    this._mid = 0
    this._pending = new Map()
    this._manualStop = false
    this._buffer = ''
  }

  get running() {
    return this.proc !== null && this.proc.exitCode === null && this.proc.killed === false
  }

  get pid() {
    return this.proc?.pid ?? null
  }

  _write(frame) {
    if (!this.running) throw new Error('sidecar not running')
    this.proc.stdin.write(JSON.stringify(frame) + '\n')
  }

  /** Send one request op and await its mid-correlated response. */
  request(op, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.running) return Promise.reject(new Error('sidecar not running'))
    const mid = ++this._mid
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(mid)
        reject(new Error(`sidecar request timed out: ${op.op}`))
      }, timeoutMs)
      this._pending.set(mid, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      try {
        this._write({ mid, ...op })
      } catch (error) {
        clearTimeout(timer)
        this._pending.delete(mid)
        reject(error)
      }
    })
  }

  /** Reply to one inbound rid (fire-and-forget, no mid correlation). */
  reply(rid, payload) {
    try {
      if (this.running) this._write({ op: 'reply', rid, ...payload })
    } catch (error) {
      this.ctx.logger.warn('dsh-gateway: reply write failed: %s', error)
    }
  }

  async start() {
    if (this.running) return
    this._manualStop = false
    this.ctx.logger.info('dsh-gateway: starting sidecar %s %s', this.pythonBin, this.scriptPath)
    const proc = spawn(this.pythonBin, [this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', DSH_GATEWAY_DATA_DIR: this.dataDir },
    })
    this.proc = proc
    this._buffer = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      this._buffer += chunk
      let index
      while ((index = this._buffer.indexOf('\n')) >= 0) {
        const line = this._buffer.slice(0, index).trim()
        this._buffer = this._buffer.slice(index + 1)
        if (line) this._handleLine(line)
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        const text = line.trimEnd()
        if (text) this.ctx.logger.info('[sidecar] %s', text)
      }
    })
    proc.on('exit', (code, signal) => {
      this.proc = null
      for (const pending of this._pending.values()) {
        pending.reject(new Error(`sidecar exited before replying (code ${code ?? signal})`))
      }
      this._pending.clear()
      if (!this._manualStop) this.onExit?.(code, signal)
    })
    proc.on('error', (error) => {
      this.ctx.logger.error('dsh-gateway: sidecar spawn error: %s', error)
    })
    const hello = await this.request({ op: 'hello' }, 20_000)
    if (hello.ok !== true) throw new Error(`sidecar hello failed: ${hello.error ?? 'unknown'}`)
    this.lastHello = hello
  }

  _handleLine(line) {
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      this.ctx.logger.warn('dsh-gateway: malformed sidecar frame: %.160s', line)
      return
    }
    if (frame.mid !== undefined && frame.mid !== null && this._pending.has(frame.mid)) {
      const pending = this._pending.get(frame.mid)
      this._pending.delete(frame.mid)
      if (frame.ok === true) pending.resolve(frame)
      else pending.reject(new Error(frame.error ?? 'sidecar op failed'))
      return
    }
    if (frame.op === 'inbound') this.onInbound?.(frame)
    else if (frame.op === 'status') this.onStatus?.(frame)
    else this.ctx.logger.warn('dsh-gateway: uncorrelated sidecar frame: %s', frame.op ?? JSON.stringify(frame).slice(0, 120))
  }

  async stop() {
    this._manualStop = true
    const proc = this.proc
    if (!proc) return
    const killAfter = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* already gone */ } }, 4_000)
    try {
      await this.request({ op: 'shutdown' }, 3_000).catch(() => {})
    } finally {
      clearTimeout(killAfter)
      try { proc.stdin.end() } catch { /* closed */ }
      try { proc.kill('SIGTERM') } catch { /* already gone */ }
      this.proc = null
    }
  }
}
