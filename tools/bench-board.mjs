#!/usr/bin/env node
/** Repeatable local board benchmark; no wall-clock pass/fail thresholds. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { TaskforceStore } from '../lib/store/index.js'
import { withWriteTransaction } from '../lib/store/sqlite.js'

const sizes = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [1000, 5000]
if (sizes.some(n => !Number.isSafeInteger(n) || n < 1 || n > 100000)) throw new TypeError('sizes must be integers between 1 and 100000')
for (const tasks of sizes) {
  const root = mkdtempSync(join(tmpdir(), 'taskforce-board-bench-'))
  const store = new TaskforceStore(root)
  try {
    store.open()
    const start = performance.now()
    withWriteTransaction(store.handle, () => {
      const task = store.handle.prepare('INSERT INTO task(title,status,run_id,created_at,updated_at) VALUES(?,?,?,?,?)')
      const fact = store.handle.prepare('INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at) VALUES(?,?,?,?,?,?)')
      for (let i = 0; i < tasks; i++) {
        const id = Number(task.run(`task-${i}`, 'open', 'bench', 'now', 'now').lastInsertRowid)
        for (let j = 0; j < 8; j++) fact.run(id, 'bench', 'fact', `fact-${i}-${j}`, 'PLAUSIBLE', 'now')
      }
    })
    const seed_ms = performance.now() - start
    for (let i = 0; i < 5; i++) store.boardPage({}, 'bench')
    const durations = []
    let board
    for (let i = 0; i < 30; i++) {
      const at = performance.now()
      board = store.boardPage({}, 'bench')
      durations.push(performance.now() - at)
    }
    durations.sort((a, b) => a - b)
    const wire = JSON.stringify({ ok: true, ...board, viewer: 'lead:bench', can_accept: true })
    console.log(JSON.stringify({ tasks, facts: tasks * 8, selected_tasks: board.tasks.length,
      json_bytes: Buffer.byteLength(wire), samples: durations.length, seed_ms,
      p50_ms: durations[Math.ceil(durations.length * .50) - 1], p95_ms: durations[Math.ceil(durations.length * .95) - 1] }))
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
}
