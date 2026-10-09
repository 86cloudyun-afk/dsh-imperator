/** Scope-visible facts: unattached facts remain visible; invalid parents do not. */
export const visibleFactsFrom = ' FROM fact f LEFT JOIN task t ON t.id=f.task_id'
  + ' WHERE f.run_id IS ? AND (f.task_id IS NULL OR (t.id IS NOT NULL AND f.run_id IS t.run_id))'
