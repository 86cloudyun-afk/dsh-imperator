/**
 * @local/dsh-taskforce — host half.
 *
 * At activation this plugin DECLARES the bundled `taskforce` agent preset to
 * the harness's agent-preset registry (`ctx.agentPresets`). Declare = enabled:
 * the registry mounts the definition's rows eagerly and hands back a disposer
 * this plugin owns, so disabling the plugin (or its row unloading) unmounts
 * them. Nothing is written to the harness home.
 *
 * The registration is released in `ctx.effect`, which runs its callback
 * immediately and treats the callback's return value as the fiber disposer.
 *
 * The definition itself lives in `./preset.js` as a plain object rather than a
 * YAML composition file: `PresetDefinition.plugins` is an ordinary Cordis
 * entry list, so no YAML reader (and no YAML dependency) is needed here.
 * Preset-local plugin files, when they arrive in phase P3, are referenced by
 * file URL built from this module's own location — the registry mounts a
 * declaration under the DECLARING loader's base, so a relative module name
 * would resolve outside this package.
 */

import { TASKFORCE_DEFINITION, TASKFORCE_PRESET_ID } from './preset.js'
import { acquireMount } from './lifecycle/mount-state.js'

/** Stable Cordis plugin name used by loader diagnostics. */
export const name = 'taskforce'

/**
 * The preset registry must exist before the definition can be declared; a
 * deployment that composes none leaves this row waiting rather than failing.
 */
export const inject = ['agentPresets']

export function apply(ctx) {
  const ownership = acquireMount('@local/dsh-taskforce')
  if (ownership === null) return
  applyImpl(ctx, ownership)
}

/**
 * Declare the preset and keep the mount slot until registration has either
 * failed without a declaration or its disposer has completed successfully.
 * @param ctx - host plugin context carrying the agent-preset registry.
 */
function applyImpl(ctx, ownership) {
  /** Disposer of the live declaration; this plugin owns it. */
  let disposeDeclaration
  /** Declaration generation: unloading invalidates late registration results. */
  let generation = 0
  let disposed = false
  let cleanupPromise

  const warn = (message) => {
    const line = `[taskforce] ${message}`
    try {
      ctx.logger?.warn?.(line)
    } catch {
      /* diagnostics must never break activation */
    }
    try {
      process.stderr.write(`${line}\n`)
    } catch {
      /* stderr is optional */
    }
  }

  const arm = () => {
    const gen = (generation += 1)
    const registration = Promise.resolve().then(async () => {
      const registry = ctx.get('agentPresets')
      if (registry === undefined || typeof registry.register !== 'function') {
        warn('agent-preset registry unavailable; preset not declared')
        ownership.release()
        return
      }
      let dispose
      try {
        dispose = await registry.register(TASKFORCE_DEFINITION)
      } catch (error) {
        warn(`declaring preset failed: ${error instanceof Error ? error.message : String(error)}`)
        ownership.release()
        return
      }
      if (typeof dispose !== 'function') {
        warn('declaring preset failed: registry returned no disposer; ownership retained')
        return
      }
      disposeDeclaration = dispose
      if (disposed || gen !== generation) return
      // Reporting must reach the boot log even where the host's logger
      // level swallows `info`: this line is the only externally visible
      // proof that the preset was declared, so it goes to stderr as well.
      const line = `[taskforce] preset "${TASKFORCE_PRESET_ID}" declared (${TASKFORCE_DEFINITION.plugins.length} rows)`
      try {
        ctx.logger?.warn?.(line)
      } catch {
        /* logging is optional */
      }
      try {
        process.stderr.write(`${line}\n`)
      } catch {
        /* stderr is optional too */
      }
    }).catch((error) => {
      // Unexpected host access errors release only before a disposer exists.
      warn(`declaring preset failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!disposeDeclaration) ownership.release()
    })
    return registration
  }

  ctx.effect(() => {
    const registration = arm()
    return () => {
      if (cleanupPromise) return cleanupPromise
      generation += 1
      disposed = true
      cleanupPromise = (async () => {
        await registration
        if (typeof disposeDeclaration !== 'function') return
        try {
          await disposeDeclaration()
          disposeDeclaration = undefined
          ownership.release()
        } catch (error) {
          warn(`unmounting preset failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      })()
      return cleanupPromise
    }
  })
}
