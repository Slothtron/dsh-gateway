// Python runtime resolution + first-activation bootstrap.
//
// The sidecar is a Python program, so `dsh plugin add` alone cannot make the
// bridge usable: npm delivers the script, while the interpreter and the
// `octop-gateway` dependency live in Python's own ecosystem. This module closes
// that gap. It probes for an interpreter that can already `import octop_gateway`
// and, when there is none, provisions a managed venv under the plugin data dir
// (uv when available, otherwise `python3 -m venv` + pip).
//
// Resolution order (mode 'auto'): explicit `pythonBin` → `<package>/.venv` (a
// development checkout) → `python3` / `python` from PATH → the managed venv.
// 'system' never installs anything; 'managed' only ever uses the managed venv.
//
// The managed venv lives in the data dir rather than the package dir: an
// installed package directory may be read-only, and a shared venv keyed by the
// data dir is what `pip install` can legitimately own.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const PROBE_TIMEOUT_MS = 20_000
const VENV_TIMEOUT_MS = 5 * 60_000
const INSTALL_TIMEOUT_MS = 15 * 60_000
const LOCK_STALE_MS = 15 * 60_000
const LOCK_WAIT_MS = 15 * 60_000
const LOCK_POLL_MS = 1_000

/** Probe snippet: report the interpreter version and the installed SDK version. */
const PROBE_SNIPPET = [
  'import sys, importlib',
  'm = importlib.import_module("octop_gateway")',
  'v = "unknown"',
  'try:',
  '    import importlib.metadata as md',
  '    v = md.version("octop-gateway")',
  'except Exception:',
  '    v = str(getattr(m, "__version__", "unknown"))',
  'print("PYTHON=" + sys.version.split()[0])',
  'print("SDK=" + v)',
].join('\n')

const VERSION_SNIPPET = 'import sys; print("PYTHON=" + sys.version.split()[0])'

/** Run one child process and resolve to its exit status, stdout and stderr. */
function run(bin, args, { timeout = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const timedOut = Boolean(error?.killed)
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      resolve({ ok: error === null, code, timedOut, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), message: error?.message ?? '' })
    })
  })
}

/** Last non-empty stderr lines of a failed command, trimmed for one log line. */
function tail(result, lines = 3, width = 400) {
  const text = (result.stderr || result.message || '').trim().split('\n').filter(Boolean).slice(-lines).join(' | ')
  return text.slice(0, width)
}

function parseVersion(stdout, key) {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(stdout)
  return match === null ? null : match[1].trim()
}

/** Probe one interpreter: does it import octop_gateway, and which versions? */
export async function probeRuntime(bin) {
  const result = await run(bin, ['-c', PROBE_SNIPPET])
  if (!result.ok) return { ok: false, bin, reason: result.timedOut ? 'probe timed out' : tail(result, 2, 200) || `exit ${result.code}` }
  return { ok: true, bin, python: parseVersion(result.stdout, 'PYTHON'), sdk: parseVersion(result.stdout, 'SDK') }
}

/** Probe an interpreter without importing octop_gateway (base for venv creation). */
async function probeInterpreter(bin) {
  const result = await run(bin, ['-c', VERSION_SNIPPET])
  if (!result.ok) return { ok: false, bin, reason: result.timedOut ? 'probe timed out' : tail(result, 2, 200) || `exit ${result.code}` }
  return { ok: true, bin, python: parseVersion(result.stdout, 'PYTHON') }
}

/** Ordered resolution candidates for one deployment. */
export function runtimeCandidates({ mode, explicitBin, packageDir, dataDir }) {
  if (explicitBin) return [{ kind: 'explicit', bin: explicitBin }]
  const packageVenv = path.join(packageDir, '.venv', 'bin', 'python')
  const managed = path.join(managedVenvDir(dataDir), 'bin', 'python')
  if (mode === 'managed') return [{ kind: 'managed', bin: managed }]
  const candidates = []
  if (mode === 'auto' && existsSync(packageVenv)) candidates.push({ kind: 'package-venv', bin: packageVenv })
  candidates.push({ kind: 'system', bin: 'python3' }, { kind: 'system', bin: 'python' })
  if (mode === 'auto') candidates.push({ kind: 'managed', bin: managed })
  return candidates
}

export function managedVenvDir(dataDir) {
  return path.join(dataDir, 'runtime', 'venv')
}

/** Best-effort cross-process lock so two profiles never install into one venv. */
async function acquireLock(lockDir, label) {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      await mkdir(lockDir)
      return async () => { await rm(lockDir, { recursive: true, force: true }).catch(() => {}) }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const age = await stat(lockDir).then((info) => Date.now() - info.mtimeMs).catch(() => 0)
      if (age > LOCK_STALE_MS) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {})
        continue
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for another process to finish ${label}`)
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
    }
  }
}

/**
 * Owns "where does the sidecar's Python come from": resolves one interpreter,
 * bootstraps a managed venv when allowed, and publishes progress for the
 * settings page.
 */
export class RuntimeManager {
  constructor({ ctx, mode, explicitBin, packageDir, dataDir, pipIndexUrl, gatewayVersion }) {
    this.ctx = ctx
    this.mode = mode === 'system' || mode === 'managed' ? mode : 'auto'
    this.explicitBin = explicitBin?.trim() ? explicitBin.trim() : null
    this.packageDir = packageDir
    this.dataDir = dataDir
    this.pipIndexUrl = pipIndexUrl?.trim() ? pipIndexUrl.trim() : null
    this.gatewayVersion = gatewayVersion?.trim() ? gatewayVersion.trim() : null
    this._resolved = null
    this._uv = undefined
    this._status = this._idleStatus()
  }

  _idleStatus() {
    return {
      mode: this.mode,
      explicitBin: this.explicitBin,
      kind: null,
      bin: null,
      python: null,
      sdk: null,
      phase: 'idle',
      lastError: null,
      attempts: [],
      updatedAt: null,
    }
  }

  /** Serializable snapshot for GET /state. */
  get status() {
    return { ...this._status, attempts: this._status.attempts.slice(-6) }
  }

  get resolved() {
    return this._resolved
  }

  /** Drop the cached resolution; `rebuild` also discards the managed venv. */
  reset({ rebuild = false } = {}) {
    this._resolved = null
    this._status = this._idleStatus()
    if (rebuild) this._pendingRebuild = true
  }

  _setPhase(phase, error = null) {
    this._status.phase = phase
    this._status.lastError = error
    this._status.updatedAt = new Date().toISOString()
    if (error) this.ctx.logger.error('dsh-gateway: python runtime: %s', error)
  }

  _record(kind, bin, reason) {
    this._status.attempts.push({ kind, bin, ok: reason === null, reason })
    this._status.updatedAt = new Date().toISOString()
  }

  /**
   * Resolve the interpreter the sidecar must run with, installing the managed
   * venv when the probes come up empty and the mode allows it.
   * @returns a resolved runtime descriptor.
   * @throws when nothing usable exists and nothing could be provisioned.
   */
  async ensure() {
    if (this._resolved) return this._resolved
    // A rebuild request must not be satisfied by probing the venv it is meant to
    // replace, so that candidate is dropped from this pass.
    const candidates = runtimeCandidates({
      mode: this.mode,
      explicitBin: this.explicitBin,
      packageDir: this.packageDir,
      dataDir: this.dataDir,
    }).filter((candidate) => !(this._pendingRebuild && candidate.kind === 'managed'))
    this._setPhase('probing')
    this.ctx.logger.info('dsh-gateway: resolving python runtime (%s): %s', this.mode, candidates.map((entry) => entry.bin).join(', '))
    for (const candidate of candidates) {
      const probe = await probeRuntime(candidate.bin)
      this._record(candidate.kind, candidate.bin, probe.ok ? null : probe.reason)
      if (!probe.ok) continue
      return this._accept(candidate.kind, candidate.bin, probe)
    }

    if (this.explicitBin) {
      throw new Error(this._describeFailure(`配置的 pythonBin 不可用：${this.explicitBin}`))
    }
    if (this.mode === 'system') {
      throw new Error(this._describeFailure('系统解释器里都没有 octop_gateway（runtime=system 不自动安装）'))
    }

    const provisioned = await this._provisionManaged()
    return this._accept('managed', provisioned.bin, provisioned)
  }

  /** Record one successful resolution on both the cache and the status snapshot. */
  _accept(kind, bin, { python, sdk }) {
    this._resolved = { kind, bin, python, sdk }
    this._pendingRebuild = false
    this._status.kind = kind
    this._status.bin = bin
    this._status.python = python
    this._status.sdk = sdk
    this._setPhase('ready')
    this.ctx.logger.info('dsh-gateway: python runtime ready (%s): %s (python %s, octop-gateway %s)', kind, bin, python, sdk)
    return this._resolved
  }

  /** Create/refresh the managed venv and install the sidecar dependency. */
  async _provisionManaged() {
    const runtimeDir = path.join(this.dataDir, 'runtime')
    const venvDir = managedVenvDir(this.dataDir)
    const venvPython = path.join(venvDir, 'bin', 'python')
    await mkdir(runtimeDir, { recursive: true })
    const release = await acquireLock(path.join(runtimeDir, 'lock'), 'the sidecar runtime install')
    try {
      if (this._pendingRebuild) {
        this._pendingRebuild = false
        this.ctx.logger.info('dsh-gateway: rebuilding the managed venv at %s', venvDir)
        await rm(venvDir, { recursive: true, force: true }).catch(() => {})
      }
      if (!existsSync(venvPython)) await this._createVenv(venvDir)

      this._setPhase('installing octop-gateway')
      const requirement = this.gatewayVersion ? `octop-gateway${this.gatewayVersion}` : 'octop-gateway'
      const indexArgs = this.pipIndexUrl ? ['--index-url', this.pipIndexUrl] : []
      const uv = await this._uvBinary()
      const install = uv
        ? await run(uv, ['pip', 'install', '--python', venvPython, ...indexArgs, requirement], { timeout: INSTALL_TIMEOUT_MS })
        : await run(venvPython, ['-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check', ...indexArgs, requirement], { timeout: INSTALL_TIMEOUT_MS })
      if (!install.ok) {
        throw new Error(this._describeFailure(
          `安装 ${requirement} 失败（${uv ? 'uv pip install' : 'pip install'} 退出码 ${install.timedOut ? 'timeout' : install.code}）`,
          tail(install, 4),
        ))
      }

      this._setPhase('probing managed venv')
      const probe = await probeRuntime(venvPython)
      this._record('managed', venvPython, probe.ok ? null : probe.reason)
      if (!probe.ok) {
        throw new Error(this._describeFailure(`托管 venv 安装后仍无法 import octop_gateway：${probe.reason}`))
      }
      await writeFile(
        path.join(runtimeDir, 'runtime.json'),
        JSON.stringify({ kind: 'managed', bin: venvPython, python: probe.python, sdk: probe.sdk, installedAt: new Date().toISOString() }, null, 2),
      ).catch(() => {})
      this.ctx.logger.info('dsh-gateway: managed venv installed at %s (python %s, octop-gateway %s)', venvPython, probe.python, probe.sdk)
      return { kind: 'managed', bin: venvPython, python: probe.python, sdk: probe.sdk }
    } finally {
      await release()
    }
  }

  /** Create the managed venv with uv when present, else the stdlib venv module. */
  async _createVenv(venvDir) {
    this._setPhase('creating venv')
    const base = await this._baseInterpreter()
    if (!base) {
      throw new Error(this._describeFailure('找不到可用的 Python 解释器（python3 / python 都不在 PATH 上）'))
    }
    const uv = await this._uvBinary()
    if (uv) {
      const made = await run(uv, ['venv', '--python', base.bin, venvDir], { timeout: VENV_TIMEOUT_MS })
      if (made.ok) {
        this.ctx.logger.info('dsh-gateway: created managed venv with uv (%s) using %s', venvDir, base.bin)
        return
      }
      this.ctx.logger.warn('dsh-gateway: uv venv failed (%s); falling back to %s -m venv', tail(made, 2, 200), base.bin)
      await rm(venvDir, { recursive: true, force: true }).catch(() => {})
    }
    const result = await run(base.bin, ['-m', 'venv', venvDir], { timeout: VENV_TIMEOUT_MS })
    if (!result.ok) {
      throw new Error(this._describeFailure(`${base.bin} -m venv 失败（退出码 ${result.timedOut ? 'timeout' : result.code}）`, tail(result, 4)))
    }
    this.ctx.logger.info('dsh-gateway: created managed venv with %s -m venv (%s)', base.bin, venvDir)
  }

  /** First interpreter that merely runs — the base for venv creation. */
  async _baseInterpreter() {
    for (const bin of ['python3', 'python']) {
      const probe = await probeInterpreter(bin)
      if (probe.ok) return probe
    }
    return null
  }

  /** Locate uv once (`null` when absent). */
  async _uvBinary() {
    if (this._uv === undefined) {
      const probe = await run('uv', ['--version'])
      this._uv = probe.ok ? 'uv' : null
      if (!this._uv) this.ctx.logger.info('dsh-gateway: uv not found; using the stdlib venv + pip')
    }
    return this._uv
  }

  _describeFailure(summary, detail = null) {
    const attempted = this._status.attempts.map((entry) => `${entry.bin}${entry.ok ? ' ✓' : ` ✗ ${entry.reason}`}`).join('\n  ')
    return [
      `Python 运行时不可用：${summary}`,
      attempted ? `已尝试的解释器：\n  ${attempted}` : null,
      detail ? `命令输出：${detail}` : null,
      '处理办法：① 装上依赖（pip install octop-gateway）；② 或在 profile patch 里把 config.pythonBin 指向已装好依赖的解释器；'
        + '③ 内网环境可设 config.pipIndexUrl 指向私有源；④ 或把 config.pythonRuntime 设为 system / managed 控制是否自动安装。',
    ].filter(Boolean).join('\n')
  }
}
