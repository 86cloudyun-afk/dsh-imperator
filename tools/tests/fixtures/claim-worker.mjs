import { TaskforceStore } from '../../../lib/store/index.js'

const [root, taskId, childId] = process.argv.slice(2)
const store = new TaskforceStore(root, { busyTimeoutMs: 5000, journalMode: 'wal' })
store.open()
process.send({ ready: true })
process.on('message', (message) => {
  if (message !== 'claim') return
  try {
    process.send({ result: store.claimTask({ task_id: Number(taskId), child_id: childId }, 'run-a') })
  } catch (error) {
    process.send({ code: error.code ?? null, error: error.message })
  } finally {
    store.close()
    process.disconnect()
  }
})
