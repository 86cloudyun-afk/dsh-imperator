import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const SCOPE_PACKAGE = '@deepseek-ai/dsh-scope'

/** Resolve at activation, after the host catalog exists. A linked bundle may
 * be outside the installation's node_modules and bare require cannot resolve
 * its host dependencies. Use the host's own package catalog, not a guessed
 * installation path or a separate copy of the SDK's private scope graph. */
export function createScopeMembership(ctx, { requireScoped = false } = {}) {
  let nativeScope
  let nativeResolved = false
  try {
    nativeScope = require(SCOPE_PACKAGE)
    nativeResolved = true
  } catch { /* linked/offline */ }
  const packages = ctx.get?.('pluginPackages')
  if (!nativeResolved && typeof packages?.packageOf === 'function') {
    const metadata = packages.packageOf(SCOPE_PACKAGE, ctx.baseUrl ?? import.meta.url)
    try {
      if (metadata?.name === SCOPE_PACKAGE && typeof metadata.manifestPath === 'string') {
        nativeScope = createRequire(metadata.manifestPath)(SCOPE_PACKAGE)
        nativeResolved = true
      }
    } catch { /* diagnose without dumping package contents */ }
  }
  // A resolved module must satisfy the same contract through either path.
  // Even null/undefined exports are a broken native module, not standalone.
  if ((nativeResolved || typeof packages?.packageOf === 'function')
    && (typeof nativeScope?.scopeOf !== 'function' || typeof nativeScope?.scopeChainOf !== 'function')) {
    throw new Error('taskforce: native scope unavailable; refusing unscoped policy activation')
  }
  return agent => {
    try {
      const owner = nativeScope?.scopeOf(ctx)
      if (owner !== undefined) {
        return nativeScope.scopeChainOf(nativeScope.scopeOf(agent?.ctx)).includes(owner)
      }
      // Compatibility only: standalone hosts without native scope can expose IDs.
      const registry = ctx.get?.('agentPresets')
      if (typeof registry?.composedPreset === 'function') {
        const preset = registry.composedPreset(ctx)
        if (preset !== undefined) return registry.composedPreset(agent?.ctx) === preset
      }
      return !requireScoped // standalone policy compatibility is opt-in for observers
    } catch {
      return undefined // unknown is NOT evidence for releasing safety rules
    }
  }
}
