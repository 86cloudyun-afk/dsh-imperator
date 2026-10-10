import { TaskforceStore } from '../../../lib/store/index.js'
import { TaskforceScheduler } from '../../../lib/scheduler/index.js'
const [root, run, requestKey] = process.argv.slice(2)
const store = new TaskforceStore(root, { busyTimeoutMs: 5000 })
process.once('message', () => {
  try {
    const result = new TaskforceScheduler(store).admitNext({ request_key: requestKey }, run, { role: 'lead', sessionId: ' root ' })
    store.close()
    process.send({ result }, () => process.disconnect())
  } catch (error) {
    store.close()
    process.send({ error: error.code ?? error.message }, () => process.disconnect())
  }
})
process.send({ ready: true })
