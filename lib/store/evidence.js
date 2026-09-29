/** Fixed aliases only: callers cannot interpolate arbitrary SQL identifiers. */
const ALIASES = new Set(['f', 'b', 'r'])

function aliasOf(value) {
  if (!ALIASES.has(value)) throw new TypeError('Invalid internal SQL alias')
  return value
}

export function evidenceBasisSql(alias) {
  const f = aliasOf(alias)
  return `(${f}.confidence IN ('CONFIRMED', 'PLAUSIBLE')`
    + ` AND (${f}.kind IN ('fact', 'artifact') OR NULLIF(TRIM(${f}.evidence_path), '') IS NOT NULL))`
}

export function validResolutionSql(resolverAlias, blockerAlias) {
  const r = aliasOf(resolverAlias)
  const b = aliasOf(blockerAlias)
  return `(${r}.resolves_fact_id = ${b}.id AND ${r}.task_id = ${b}.task_id`
    + ` AND ${r}.run_id IS ${b}.run_id AND ${r}.kind = 'decision'`
    + ` AND ${r}.confidence IN ('CONFIRMED', 'PLAUSIBLE'))`
}

export function assertResolutionInput({ kind, confidence, resolves_fact_id }) {
  if (resolves_fact_id === undefined || resolves_fact_id === null) return
  if (kind !== 'decision' || !['CONFIRMED', 'PLAUSIBLE'].includes(confidence)) {
    const error = new Error('消解阻塞必须是 decision，confidence 必须为 CONFIRMED 或 PLAUSIBLE')
    error.code = 'E_RESOLUTION_INVALID'
    throw error
  }
}
