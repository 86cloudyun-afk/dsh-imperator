const OWNERS = Symbol.for('dsh-taskforce.mount-owners')
const LEGACY_MOUNTED = Symbol.for('dsh-web.mounted-plugins')

/** Claim a process-wide package slot without modifying the host's legacy Set. */
export function acquireMount(packageName) {
  if (globalThis[LEGACY_MOUNTED]?.has(packageName)) return null
  const owners = (globalThis[OWNERS] ??= new Map())
  if (owners.has(packageName)) return null
  const token = Symbol(packageName)
  owners.set(packageName, token)
  return {
    token,
    release() {
      if (globalThis[OWNERS]?.get(packageName) !== token) return false
      globalThis[OWNERS].delete(packageName)
      return true
    },
  }
}
