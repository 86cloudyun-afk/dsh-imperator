import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const manifest = (path) => JSON.parse(readFileSync(path, 'utf8'))
function isAnchor(path) {
  try { return manifest(path).name === '@deepseek-ai/dsh' } catch { return false }
}

/** Explicit paths fail closed; global bin symlinks resolve to the real npm package. */
export function resolveInstallAnchor({ installAnchor, installDir,
  path = process.env.PATH ?? '' } = {}) {
  if (installAnchor === undefined && installDir === undefined) installAnchor = process.env.DSH_INSTALL_ANCHOR
  if (installAnchor !== undefined) {
    const anchor = resolve(installAnchor)
    if (!isAnchor(anchor)) throw new Error('UNVERIFIED: --install-anchor must name @deepseek-ai/dsh/package.json')
    return realpathSync(anchor)
  }
  if (installDir !== undefined) {
    if (!statSync(resolve(installDir), { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('UNVERIFIED: --install-dir / entryListProblem registry unavailable')
    }
    const candidates = [join(resolve(installDir), '@deepseek-ai/dsh/package.json'), join(dirname(resolve(installDir)), 'package.json')]
    const anchor = candidates.find(isAnchor)
    if (!anchor) throw new Error('UNVERIFIED: DSH installation anchor / entryListProblem registry unavailable in --install-dir')
    return realpathSync(anchor)
  }
  for (const directory of path.split(delimiter).filter(Boolean)) {
    try {
      const bin = join(directory, 'dsh')
      accessSync(bin, constants.X_OK)
      let directoryPath = dirname(realpathSync(bin))
      while (true) {
        const anchor = join(directoryPath, 'package.json')
        if (isAnchor(anchor)) return anchor
        const parent = dirname(directoryPath)
        if (parent === directoryPath) break
        directoryPath = parent
      }
    } catch { /* continue through PATH */ }
  }
  throw new Error('UNVERIFIED: native DSH not found; supply --install-anchor')
}

export const nativeModule = (anchor, name) => import(pathToFileURL(createRequire(anchor).resolve(name)).href)
export const installationVersion = (anchor) => manifest(anchor).version

const nativeEvents = ['unhandledRejection', 'uncaughtException', 'SIGTERM', 'SIGINT']
let activeProfile

/** Isolated verifier lifecycle. The injected emitter/boot are only a unit-test
 * seam; controlledProfile always supplies the real native runProfile. */
export function createProfileLifecycle(boot, { emitter = process, release = () => {} } = {}) {
  let started = false, bootPending = false, app, shutdownWork, shutdownSettled = false
  let requested = false, disposed = false, complete
  const pending = new Set(), captured = [], diagnostics = []
  const whenDisposed = new Promise(resolve => { complete = resolve })
  const snapshot = () => nativeEvents.map(event => emitter.rawListeners(event))
  const unfinished = () => bootPending || pending.size > 0 || (app && !shutdownSettled)
  const finish = () => {
    if (!requested || disposed || unfinished()) return
    disposed = true
    try {
      for (const [event, callback] of captured) emitter.removeListener(event, callback)
      release()
    } catch (error) { diagnostics.push(error) }
    finally { complete() }
  }
  const check = () => {
    const failures = [...diagnostics]
    if (unfinished()) failures.push(new Error('native fixture teardown pending'))
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'native fixture cleanup failed')
  }
  const teardown = work => {
    if (disposed) return Promise.reject(new Error('native fixture already disposed'))
    // Track the original work's settlement, never its caller's deadline race.
    let actual
    try { actual = Promise.resolve(work()) } catch (error) { actual = Promise.reject(error) }
    pending.add(actual)
    const settled = () => { pending.delete(actual); finish() }
    actual.then(settled, settled)
    return actual
  }
  return {
    whenDisposed, check, teardown, isDisposed: () => disposed,
    runProfile(options) {
      if (started || disposed) return Promise.reject(new Error('native fixture may boot only once'))
      started = true; bootPending = true
      const before = snapshot()
      const capture = value => {
        app = value
        // Capture immediately at native boot settlement. Never infer ownership
        // from a later disposal-time difference or expand an unexpected delta.
        const after = snapshot()
        for (let index = 0; index < nativeEvents.length; index++) {
          const counts = new Map()
          for (const callback of before[index]) counts.set(callback, (counts.get(callback) ?? 0) + 1)
          const added = []
          for (const callback of after[index]) {
            const count = counts.get(callback) ?? 0
            if (count) counts.set(callback, count - 1)
            else added.push(callback)
          }
          if ([...counts.values()].some(Boolean) || added.length > 1 || (app && added.length !== 1)) {
            diagnostics.push(new Error(`native fixture listener ownership mismatch: ${nativeEvents[index]}`))
          } else for (const callback of added) captured.push([nativeEvents[index], callback])
        }
        bootPending = false; finish()
      }
      let actual
      try { actual = Promise.resolve(boot(options)) } catch (error) { actual = Promise.reject(error) }
      // Observe before returning the original Promise. An async wrapper adds a
      // continuation hop and races native startup against immediate shutdown.
      actual.then(value => capture(value), () => capture(undefined))
      return actual
    },
    shutdown(code) {
      if (!app) return Promise.resolve()
      if (!shutdownWork) {
        shutdownWork = teardown(() => app.shutdown.shutdown(code))
        const settled = () => { shutdownSettled = true; finish() }
        shutdownWork.then(settled, settled)
      }
      return shutdownWork
    },
    dispose() { requested = true; finish(); check() },
  }
}

/** Call only in an isolated verifier process: native boot owns global env and
 * resolution. Reserve ownership before mkdir, env mutation or the first await. */
export async function controlledProfile(anchor, packageRoot) {
  if (activeProfile) throw new Error('active controlled profile already owns the verifier environment')
  const token = activeProfile = Symbol('controlled profile')
  let root, released = false
  const previousHome = process.env.DSH_HOME
  const previousTelemetry = process.env.DSH_TELEMETRY_DISABLED
  const emergencyDispose = () => { if (root) rmSync(root, { recursive: true, force: true }) }
  const release = () => {
    if (released) return
    released = true
    try { emergencyDispose() }
    finally {
      if (activeProfile === token) {
        if (previousHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previousHome
        if (previousTelemetry === undefined) delete process.env.DSH_TELEMETRY_DISABLED
        else process.env.DSH_TELEMETRY_DISABLED = previousTelemetry
        activeProfile = undefined
      }
    }
  }
  try {
    root = mkdtempSync(join(tmpdir(), 'taskforce-host-'))
    process.env.DSH_HOME = join(root, 'home')
    process.env.DSH_TELEMETRY_DISABLED = '1'
    const boot = await nativeModule(anchor, '@deepseek-ai/dsh-app-boot')
    const profile = boot.loadProfile('dsh', 'web', anchor)
    const file = join(profile.dir, 'package.json')
    const config = manifest(file)
    config.dependencies ??= {}
    config.dependencies['@local/dsh-taskforce'] = `file:${packageRoot}`
    config.dsh.profile.bundles.push('@local/dsh-taskforce')
    writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
    mkdirSync(join(profile.dir, 'node_modules/@local'), { recursive: true })
    symlinkSync(packageRoot, join(profile.dir, 'node_modules/@local/dsh-taskforce'), 'dir')
    const overlay = join(root, 'probe.patch.yml')
    writeFileSync(overlay, '- id: web-runtime\n  config:\n    openBrowser: false\n    printUrl: false\n    surfaceContext: true\n    trustedHosts: []\n')
    const { runProfile } = await import(pathToFileURL(join(dirname(anchor), 'lib/profile-boot.js')).href)
    return { root, overlay, boot, profile: boot.loadProfile('dsh', 'web', anchor), emergencyDispose,
      ...createProfileLifecycle(runProfile, { release }) }
  } catch (error) {
    try { release() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'controlled profile setup failed') }
    throw error
  }
}

export function collectRows(plugins, out = []) {
  for (const row of plugins) {
    out.push(row)
    if (row.name === 'cordis:group' && Array.isArray(row.config)) collectRows(row.config, out)
  }
  return out
}
