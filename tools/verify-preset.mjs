#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TASKFORCE_DEFINITION } from '../lib/preset.js'
import { collectRows, controlledProfile, nativeModule, resolveInstallAnchor } from './host-runtime.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Native profile resolution and Cordis Config validation, without activating
 * plugins. Run in an isolated process; verify-host covers actual boot. */
export async function verifyPreset({ installAnchor, installDir, profileDir, definition = TASKFORCE_DEFINITION } = {}) {
  const anchor = resolveInstallAnchor({ installAnchor, installDir })
  if (profileDir !== undefined && !existsSync(profileDir)) throw new Error('UNVERIFIED: profile directory unavailable')
  let fixture
  let scope
  const problems = []
  try {
    const boot = await nativeModule(anchor, '@deepseek-ai/dsh-app-boot')
    const { Context, resolveConfig } = await nativeModule(anchor, '@deepseek-ai/cordis')
    const { createScope } = await nativeModule(anchor, '@deepseek-ai/dsh-scope')
    const { entryListProblem } = await nativeModule(anchor, '@deepseek-ai/dsh-agent-preset-registry')
    if (typeof entryListProblem !== 'function') throw new Error('UNVERIFIED: entryListProblem unavailable')
    const structure = entryListProblem(definition.plugins)
    if (structure !== undefined) problems.push(structure)
    const profile = profileDir === undefined
      ? (fixture = await controlledProfile(anchor, ROOT)).profile
      : boot.loadProfileDirectory('dsh', resolve(profileDir), anchor)
    if (profile.skippedBundles.length) problems.push(...profile.skippedBundles.map(row => `${row.packageName}: ${row.reason}`))
    const resolution = await boot.createRuntimeResolution({ installAnchor: anchor, profile,
      ...(fixture ? { home: join(fixture.root, 'home') } : {}) })
    scope = createScope(new Context(), {})
    new boot.PluginPackages(scope.ctx, { resolution })
    const require = createRequire(join(profile.dir, 'package.json'))
    for (const row of collectRows(definition.plugins)) {
      if (row.name === 'cordis:group') continue
      try {
        if (row.name.startsWith('.') || row.name.startsWith('/')) throw new Error('local preset row must use an absolute file URL')
        const url = row.name.startsWith('file:') ? row.name : pathToFileURL(require.resolve(row.name)).href
        const module = await import(url)
        const plugin = module.default ?? module
        if (typeof plugin !== 'function' && typeof plugin.apply !== 'function') throw new Error('module is not a Cordis plugin')
        resolveConfig(plugin, row.config ?? {})
      } catch (error) { problems.push(`${row.id}: ${error.message}`) }
    }
    return { ok: problems.length === 0, rows: collectRows(definition.plugins).length, problems }
  } finally { await scope?.dispose(); fixture?.dispose() }
}

export function option(args, name) {
  const inline = args.find(arg => arg.startsWith(`${name}=`))
  const index = args.indexOf(name)
  return inline ? inline.slice(name.length + 1) : index < 0 ? undefined : args[index + 1]
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const profileDir = option(args, '--profile-dir') ?? (args[0]?.startsWith('--') ? undefined : args[0])
  console.log(`profile     : ${profileDir ?? '(isolated native profile)'}`)
  try {
    const result = await verifyPreset({ profileDir, installDir: option(args, '--install-dir'), installAnchor: option(args, '--install-anchor') })
    for (const problem of result.problems) console.error(`FAIL: ${problem}`)
    console.log(`${result.ok ? 'PASSED' : 'FAILED'}: ${result.rows} rows — structure, native resolution, plugin shape, Config`)
    process.exitCode = result.ok ? 0 : 1
  } catch (error) { console.log(error.message); process.exitCode = 1 }
}
