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

/** Call only in an isolated verifier process: native boot owns global env and
 * resolution. The caller disposes the application before deleting the home. */
export async function controlledProfile(anchor, packageRoot) {
  const root = mkdtempSync(join(tmpdir(), 'taskforce-host-'))
  const previousHome = process.env.DSH_HOME
  const previousTelemetry = process.env.DSH_TELEMETRY_DISABLED
  process.env.DSH_HOME = join(root, 'home')
  process.env.DSH_TELEMETRY_DISABLED = '1'
  const dispose = () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousTelemetry === undefined) delete process.env.DSH_TELEMETRY_DISABLED
    else process.env.DSH_TELEMETRY_DISABLED = previousTelemetry
    rmSync(root, { recursive: true, force: true })
  }
  try {
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
    return { root, overlay, boot, profile: boot.loadProfile('dsh', 'web', anchor), dispose }
  } catch (error) { dispose(); throw error }
}

export function collectRows(plugins, out = []) {
  for (const row of plugins) {
    out.push(row)
    if (row.name === 'cordis:group' && Array.isArray(row.config)) collectRows(row.config, out)
  }
  return out
}
