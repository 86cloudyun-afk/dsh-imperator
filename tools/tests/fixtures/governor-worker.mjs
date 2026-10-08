import { TaskforceStore } from '../../../lib/store/index.js'
import { TaskforceGovernor } from '../../../lib/governor/index.js'
const store = new TaskforceStore(process.argv[2], { busyTimeoutMs: 5000 })
const governor = new TaskforceGovernor(store)
governor.snapshot('run')
process.send('ready')
process.once('message', () => {
  try {
    process.send(governor.reserve({ task_id: Number(process.argv[3]), operation_key: `race-${process.argv[3]}`, generation: 0, mode: 'read', kind: 'reuse', resources: [] }, 'run', { role: 'lead', sessionId: 'root' }))
  } catch (error) { process.send({ code: error.code, message: error.message }) }
  finally { store.close(); process.disconnect() }
})
