#!/usr/bin/env node
/** Bounded synthetic faults: real connections, rollback, writer contention,
 * SIGKILL with an open SQLite transaction, reopen, board and hook parity.
 * No provider calls, external commands, task execution or production roots.
 */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { options, syntheticRoot, populate, putters, hookEvidence, scopeFixture, sizes, memory, safeDiagnostic } from './probe-nextgen.mjs'

const SELF = fileURLToPath(import.meta.url)
const RUN = 'probe-run'
let phase = 'startup'
const emit = value => console.log(JSON.stringify(value))
const count = store => Number(store.handle.prepare('SELECT COUNT(*) AS n FROM fact').get().n)
const page = (store, id) => store.boardPage({ view: 'late_blockers', task_id: id, limit: 1 }, RUN)
const next = (store, id, first) => store.boardPage({ view: 'late_blockers', task_id: id, limit: 1,
  cursor: first.pagination.next_cursor, page_token: first.pagination.page_token }, RUN)

async function writerChild(root, taskId) {
  assert.equal(readFileSync(join(root, '.nextgen-synthetic'), 'utf8'), 'synthetic only\n')
  const { TaskforceStore } = await import('../lib/store/index.js')
  const store = new TaskforceStore(root, { journalMode: 'wal', busyTimeoutMs: 0 })
  store.open()
  store.handle.exec('BEGIN IMMEDIATE')
  const id = putters(store.handle).fact(taskId, RUN, 'blocker')
  process.send({ kind: 'transaction_open', id })
  // Keep the real uncommitted writer alive until the parent sends SIGKILL.
  setInterval(() => {}, 1000)
}
async function killedWriter(root, taskId, duringTransaction) {
  const child = fork(SELF, ['--crash-writer', root, String(taskId)],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] })
  let timer, deathTimer
  try {
    const opened = await new Promise((resolveReady, rejectReady) => {
      timer = setTimeout(() => rejectReady(new Error('writer readiness timeout')), 30000)
      child.once('error', rejectReady)
      child.once('exit', () => rejectReady(new Error('writer exited before ready')))
      child.once('message', message => {
        if (message?.kind === 'transaction_open' && Number.isSafeInteger(message.id)) resolveReady(message)
        else rejectReady(new Error('invalid writer evidence'))
      })
    })
    clearTimeout(timer)
    duringTransaction(opened)
    const death = new Promise((resolveExit, rejectExit) => {
      deathTimer = setTimeout(() => rejectExit(new Error('writer death timeout')), 10000)
      child.once('error', rejectExit)
      child.once('exit', (code, signal) => resolveExit({ code, signal }))
    })
    assert.equal(child.kill('SIGKILL'), true)
    const result = await death
    clearTimeout(deathTimer)
    assert.equal(result.signal, 'SIGKILL')
    return { writer_transaction_observed: true, actual_sigkill_observed: true }
  } finally {
    clearTimeout(timer)
    clearTimeout(deathTimer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}
async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--crash-writer') { await writerChild(args[1], Number(args[2])); return }
  phase = 'configuration'
  const opts = options(args)
  const { TaskforceStore } = await import('../lib/store/index.js')
  const { withWriteTransaction, withReadTransaction } = await import('../lib/store/sqlite.js')
  const root = syntheticRoot('taskforce-nextgen-soak-')
  const open = () => { const store = new TaskforceStore(root, { journalMode: 'wal', busyTimeoutMs: 0 }); store.open(); return store }
  let a, b
  emit({ kind: 'nextgen_soak_configuration', ...opts, node: process.version, synthetic: true, provider_calls: 0,
    scope: 'SQLite and plugin fault assertions; not production or model acceptance', timing_gate: false })
  try {
    phase = 'seed'
    a = open(); const fixture = await populate(a, opts.facts); b = open()
    for (let round = 0; round < opts.rounds; round++) {
      phase = 'rollback'
      const at = performance.now(), before = count(a), beforePage = page(a, fixture.own)
      assert.ok(beforePage.pagination.page_token && beforePage.pagination.next_cursor)
      const failure = Object.assign(new Error('synthetic injected rollback'), { code: 'E_SYNTHETIC_FAULT' })
      assert.throws(() => withWriteTransaction(b.handle, () => {
        putters(b.handle).fact(fixture.own, RUN, 'blocker')
        throw failure
      }), error => error === failure)
      assert.equal(count(a), before)
      assert.deepEqual(page(a, fixture.own), beforePage)
      assert.equal(b.handle.isTransaction, false)

      // SQLite WAL keeps a multi-query read snapshot consistent while another
      // real connection commits. After that snapshot, the new member is visible.
      phase = 'wal-snapshot'
      let inserted
      withReadTransaction(a.handle, () => {
        const snapshot = page(a, fixture.own)
        inserted = withWriteTransaction(b.handle, () => putters(b.handle).fact(fixture.own, RUN, 'blocker'))
        assert.deepEqual(page(a, fixture.own), snapshot)
      })
      assert.equal(page(a, fixture.own).late_blockers[0].fact_id, inserted)
      assert.equal(count(a), before + 1)
      assert.doesNotThrow(() => next(a, fixture.own, beforePage), 'later insertion above ceiling must preserve old continuation')

      // Writer contention is a genuine competing connection, with zero timeout.
      phase = 'writer-contention'
      const beforeBusy = count(a)
      withWriteTransaction(a.handle, () => {
        assert.throws(() => withWriteTransaction(b.handle, () => putters(b.handle).fact(fixture.own, RUN, 'blocker')),
          { code: 'E_STORE_BUSY' })
      })
      assert.equal(count(a), beforeBusy)
      assert.equal(a.handle.isTransaction, false); assert.equal(b.handle.isTransaction, false)

      // A resolver inserted above the cohort ceiling must invalidate the token.
      phase = 'resolver-invalidation'
      const beforeResolution = page(a, fixture.own)
      const upper = JSON.parse(Buffer.from(beforeResolution.pagination.page_token, 'base64url').toString()).u
      const resolver = withWriteTransaction(b.handle, () =>
        putters(b.handle).fact(fixture.own, RUN, 'decision', 'CONFIRMED', inserted))
      assert.ok(resolver > upper)
      assert.throws(() => next(a, fixture.own, beforeResolution), { code: 'E_PAGE_CHANGED' })
      phase = 'round-reopen'
      const expected = page(a, fixture.own)
      a.close(); b.close(); a = open(); b = open()
      assert.deepEqual(page(a, fixture.own), expected)
      assert.equal(Object.values(a.handle.prepare('PRAGMA integrity_check').get())[0], 'ok')
      emit({ kind: 'nextgen_soak_round', round: round + 1, elapsed_ms: performance.now() - at,
        rollback: true, concurrent_wal_snapshot: true, busy_writer: true, later_insert_valid: true,
        resolver_invalidation: true, reopen_parity: true, integrity: true, ...sizes(root, a.handle), ...memory() })
    }
    phase = 'sigkill-writer'
    const beforeCrash = count(a), expected = page(a, fixture.own)
    const crash = await killedWriter(root, fixture.own, () => {
      assert.equal(count(a), beforeCrash, 'uncommitted writer leaked')
      assert.deepEqual(page(a, fixture.own), expected)
    })
    a.close(); b.close(); a = open(); b = open()
    assert.equal(count(a), beforeCrash, 'killed uncommitted writer survived reopen')
    assert.deepEqual(page(a, fixture.own), expected)
    assert.equal(Object.values(a.handle.prepare('PRAGMA integrity_check').get())[0], 'ok')
    emit({ kind: 'nextgen_soak_crash', ...crash, rollback_after_restart: true, integrity: true, ...sizes(root, a.handle), ...memory() })
    phase = 'scope-fixtures'
    emit({ kind: 'nextgen_soak_scope', ...(await scopeFixture()) })
    phase = 'long-event-hooks'
    const events = await hookEvidence(opts.events, opts.rounds)
    emit({ kind: 'nextgen_soak_events', events: opts.events, semantic_assertions: 'passed' })
    for (const measurement of events) emit({ kind: 'nextgen_soak_event_measurement', ...measurement })
    emit({ kind: 'nextgen_soak_complete', semantic_assertions: 'passed', rounds: opts.rounds, timing_gate: false })
  } finally { a?.close(); b?.close(); rmSync(root, { recursive: true, force: true }) }
}
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  main().catch(error => { emit({ kind: 'nextgen_soak_failure', ...safeDiagnostic(error, phase, 'E_SOAK_ASSERTION_OR_RUNTIME') }); process.exitCode = 1 })
}
