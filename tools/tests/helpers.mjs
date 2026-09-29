import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskforceStore } from '../../lib/store/index.js'

export function tempStore(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'taskforce-sqlite-'))
  const store = new TaskforceStore(root, options)
  t.after(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return store
}

export function seedSubmitted(store, runId) {
  const id = store.openTask({ title: '待验收' }, runId).task_id
  store.recordFact({ task_id: id, kind: 'artifact', statement: '产物已生成', confidence: 'PLAUSIBLE', evidence_path: 'artifact.txt' }, runId)
  store.submitTask({ task_id: id, note: '请验收' }, runId)
  return id
}

export function fakePresetHost({ register, onLog }) {
  const disposers = []
  const logs = []
  const ctx = {
    get(service) {
      return service === 'agentPresets' ? { register } : undefined
    },
    logger: { warn: (line) => { logs.push(line); onLog?.(line) } },
    effect(callback) {
      disposers.push(callback())
    },
  }
  return {
    ctx,
    logs,
    async disposeAll() {
      for (const dispose of disposers) await dispose()
    },
  }
}
