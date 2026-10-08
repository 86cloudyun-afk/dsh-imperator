/** Configuration and capability claims are not evidence of native enforcement. */
const BLOCKERS = [
  ['H01', 'prebound native session identity'],
  ['H02', 'complete managed input admission boundary'],
  ['H03', 'strict durable backend flush and lookup'],
  ['H04', 'subtree and process quiescence proof'],
  ['H05', 'exclusive owner lock and recovery'],
  ['H06', 'trusted workspace identity and isolation'],
]
export function createNativeGovernorAdapter() {
  throw Object.assign(new Error('Native managed admission blocked: unresolved H01–H06'), {
    code: 'E_SCHEDULER_CAPABILITY',
    blockers: BLOCKERS.map(([code, capability]) => ({ code, capability })),
  })
}
