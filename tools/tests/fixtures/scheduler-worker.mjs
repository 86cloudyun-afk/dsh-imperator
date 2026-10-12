import { TaskforceStore } from '../../../lib/store/index.js'
import { TaskforceScheduler } from '../../../lib/scheduler/index.js'
const [root, run, requestKey, action = 'admit', requestId] = process.argv.slice(2)
const store = new TaskforceStore(root, { busyTimeoutMs: 5000 })
store.open()
process.once('message', () => {
  try {
    const scheduler = new TaskforceScheduler(store)
    const authority = { role: 'lead', sessionId: ' root ' }
    const before = store.open().prepare('SELECT total_changes() AS n').get().n
    const result = action === 'withdraw'
      ? scheduler.withdraw({ request_key: requestKey, request_id: requestId }, run, authority)
      : scheduler.admitNext({ request_key: requestKey }, run, authority)
    const changes = store.open().prepare('SELECT total_changes() AS n').get().n - before
    store.close()
    process.send({ result, changes, pid: process.pid }, () => process.disconnect())
  } catch (error) {
    store.close()
    process.send({ error: error.code ?? error.message }, () => process.disconnect())
  }
})
process.send({ ready: true, pid: process.pid })
