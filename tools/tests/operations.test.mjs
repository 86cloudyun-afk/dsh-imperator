import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TaskforceGovernor } from '../../lib/governor/index.js'
import { TaskforceScheduler } from '../../lib/scheduler/index.js'
import { TaskforceStore } from '../../lib/store/index.js'

let operations
try { operations = await import('../../lib/operations/index.js') } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
}
const SENTINEL = 'OPERATOR_SECRET_SENTINEL'
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
function api() {
  for (const name of ['doctor', 'backup', 'preflight', 'restore']) {
    assert.equal(typeof operations?.[name], 'function', 'missing operator capability: ' + name)
  }
  return operations
}
function fixture(t, options = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'imperator-operations-')))
  const root = join(directory, 'live')
  const workspace = join(directory, 'workspace')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'source.js'), 'process.exitCode = 0\n')
  const store = new TaskforceStore(root, options)
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, root, workspace, store }
}
function seed(f, withReceipt = false, run = 'run') {
  const task = f.store.openTask(withReceipt ? {
    title: SENTINEL, evidence_policy: 'execution',
    verification_files: ['source.js'], verification_command: 'node source.js',
  } : { title: SENTINEL }, run, { isRoot: true, sessionId: run, cwd: f.workspace })
  if (withReceipt) {
    f.store.claimTask({ task_id: task.task_id, child_id: 'worker' }, run,
      { isRoot: false, sessionId: 'worker' }, 'worker')
    const receipt = f.store.recordExecution({ task_id: task.task_id, status: 'pending',
      command: 'node source.js', call_id: 'call', root_call_id: 'call', timeout_ms: 1000 },
    run, { isRoot: false, sessionId: 'worker' })
    f.store.recordExecution({ task_id: task.task_id, receipt_id: receipt.receipt_id,
      native_result: { isError: false, value: { kind: 'foreground', exitCode: 0, signal: null,
        timedOut: false, aborted: false, timeoutMs: 1000,
        stdout: { text: SENTINEL, truncated: false }, stderr: { text: '', truncated: false } } } },
    run, { isRoot: false, sessionId: 'worker' })
    return { ...task, receipt_id: receipt.receipt_id }
  }
  return task
}
function safe(report) {
  const json = JSON.stringify(report)
  assert.ok(Buffer.byteLength(json) <= 8192, 'bounded report')
  assert.doesNotMatch(json, /OPERATOR_SECRET_SENTINEL|source\.js|imperator-operations-/)
  return report
}
function bytes(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function database(path, action) {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return action(db) } finally { db.close() }
}
function tableRows(db) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid').all()]))
}

test('doctor creates neither a missing database nor a missing root', async t => {
  const ops = api(), f = fixture(t), missing = join(f.directory, 'absent', 'nested')
  const result = safe(await ops.doctor({ root: missing }))
  assert.equal(result.ok, false)
  assert.ok(result.checks.some(check => check.code === 'DATABASE_MISSING'))
  assert.equal(existsSync(join(f.directory, 'absent')), false)
})
test('doctor does not migrate legacy schema or change rows, files or journal mode', async t => {
  const ops = api(), f = fixture(t)
  mkdirSync(f.root)
  const db = new DatabaseSync(join(f.root, 'taskforce.db'))
  db.exec("CREATE TABLE task(id INTEGER PRIMARY KEY,title TEXT NOT NULL,note TEXT,status TEXT,owner TEXT,created_at TEXT,updated_at TEXT); INSERT INTO task VALUES(1,'OPERATOR_SECRET_SENTINEL',NULL,'open',NULL,'then','then')")
  db.close()
  const before = bytes(join(f.root, 'taskforce.db'))
  const listing = readdirSync(f.root)
  const result = safe(await ops.doctor({ root: f.root }))
  assert.equal(result.ok, false)
  assert.ok(result.checks.some(check => check.code === 'SCHEMA_UPGRADE_REQUIRED'))
  assert.equal(bytes(join(f.root, 'taskforce.db')), before)
  assert.deepEqual(readdirSync(f.root), listing)
  assert.equal(database(join(f.root, 'taskforce.db'), handle => handle.prepare('PRAGMA journal_mode').get().journal_mode), 'delete')
})
test('doctor reports healthy current SQLite without exposing task text or log contents', async t => {
  const ops = api(), f = fixture(t)
  seed(f, true)
  const before = tableRows(f.store.handle)
  const result = safe(await ops.doctor({ root: f.root }))
  assert.equal(result.ok, true)
  assert.equal(result.counts.tasks, 1)
  assert.equal(result.counts.receipts, 1)
  assert.equal(result.counts.invalid_logs, 0)
  assert.deepEqual(tableRows(f.store.handle), before)
})
test('doctor reports corruption and unexpected SQLite schema using only stable codes', async t => {
  const ops = api(), f = fixture(t)
  mkdirSync(f.root)
  writeFileSync(join(f.root, 'taskforce.db'), SENTINEL)
  const report = safe(await ops.doctor({ root: f.root }))
  assert.equal(report.ok, false)
  assert.ok(report.checks.some(check => check.code === 'DATABASE_INVALID'))
})
test('live WAL online backup includes committed WAL and excludes uncommitted second-connection work', async t => {
  const ops = api(), f = fixture(t, { journalMode: 'wal' })
  const task = seed(f)
  f.store.handle.exec('PRAGMA wal_autocheckpoint=0')
  f.store.recordFact({ task_id: task.task_id, statement: 'committed-WAL' }, 'run')
  const writer = new DatabaseSync(f.store.dbPath)
  t.after(() => writer.close())
  writer.exec('BEGIN IMMEDIATE')
  writer.prepare("INSERT INTO fact(task_id,run_id,kind,statement,confidence,created_at) VALUES(?,'run','fact','UNCOMMITTED','PLAUSIBLE','now')").run(task.task_id)
  const out = join(f.directory, 'backup')
  const result = safe(await ops.backup({ root: f.root, out }))
  assert.equal(result.ok, true)
  const statements = database(join(out, 'taskforce.db'), db => db.prepare('SELECT statement FROM fact').all().map(row => row.statement))
  assert.deepEqual(statements, ['committed-WAL'])
  writer.exec('ROLLBACK')
  assert.ok(existsSync(join(out, 'manifest.json')))
  assert.equal(existsSync(join(out, 'taskforce.db-wal')), false)
})
test('backup preserves exact database rows and canonical immutable receipt log bytes', async t => {
  const ops = api(), f = fixture(t), task = seed(f, true)
  const before = tableRows(f.store.handle), out = join(f.directory, 'backup')
  assert.equal(safe(await ops.backup({ root: f.root, out })).ok, true)
  assert.deepEqual(database(join(out, 'taskforce.db'), tableRows), before)
  for (const stream of ['stdout', 'stderr']) {
    const relative = join('receipts', task.receipt_id + '.' + stream + '.log')
    assert.deepEqual(readFileSync(join(out, relative)), readFileSync(join(f.root, relative)))
  }
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
  assert.equal(manifest.format, 'imperator-backup')
  assert.equal(manifest.version, 1)
  for (const entry of manifest.files) {
    assert.equal(entry.sha256, bytes(join(out, entry.path)))
    assert.equal(entry.bytes, statSync(join(out, entry.path)).size)
  }
})
for (const fault of ['missing', 'tampered', 'symlink', 'traversal']) {
  test('backup rejects ' + fault + ' receipt logs without publishing or touching source rows', async t => {
    const ops = api(), f = fixture(t), task = seed(f, true)
    const path = join(f.root, 'receipts', task.receipt_id + '.stdout.log')
    if (fault === 'missing') rmSync(path)
    if (fault === 'tampered') writeFileSync(path, 'tampered')
    if (fault === 'symlink') {
      const other = join(f.directory, 'foreign')
      writeFileSync(other, readFileSync(path)); rmSync(path); symlinkSync(other, path)
    }
    if (fault === 'traversal') {
      const row = f.store.handle.prepare('SELECT logs FROM execution_receipt').get()
      const logs = JSON.parse(row.logs); logs.stdout.path = join(f.directory, 'foreign')
      f.store.handle.prepare('UPDATE execution_receipt SET logs=?').run(JSON.stringify(logs))
    }
    const before = tableRows(f.store.handle), listing = readdirSync(f.directory), out = join(f.directory, 'failed-backup')
    await assert.rejects(ops.backup({ root: f.root, out }), { code: 'E_OPERATIONS_LOG' })
    assert.equal(existsSync(out), false)
    assert.deepEqual(readdirSync(f.directory), listing)
    assert.deepEqual(tableRows(f.store.handle), before)
  })
}
test('backup preserves pending execution as unresolved and never invents log evidence', async t => {
  const ops = api(), f = fixture(t), task = seed(f, true)
  f.store.handle.prepare("UPDATE execution_receipt SET status='pending',ended_at=NULL,outcome=NULL,logs=NULL").run()
  const out = join(f.directory, 'backup')
  assert.equal((await ops.backup({ root: f.root, out })).ok, true)
  const receipt = database(join(out, 'taskforce.db'), db => db.prepare('SELECT status,logs FROM execution_receipt').get())
  assert.equal(receipt.status, 'pending')
  assert.equal(receipt.logs, null)
  assert.equal(existsSync(join(out, 'receipts', task.receipt_id + '.stdout.log')), false)
})
for (const kind of ['existing', 'nested', 'source-symlink', 'parent-symlink']) {
  test('backup refuses ' + kind + ' filesystem destinations or sources', async t => {
    const ops = api(), f = fixture(t); seed(f)
    let root = f.root, out = join(f.directory, 'backup')
    if (kind === 'existing') mkdirSync(out)
    if (kind === 'nested') out = join(f.root, 'backup')
    if (kind === 'source-symlink') { root = join(f.directory, 'link'); symlinkSync(f.root, root) }
    if (kind === 'parent-symlink') {
      const link = join(f.directory, 'link'); symlinkSync(f.directory, link); out = join(link, 'backup')
    }
    await assert.rejects(ops.backup({ root, out }), error => /^E_OPERATIONS_(PATH|EXISTS)$/.test(error.code))
    assert.equal(f.store.stats('run').tasks.total, 1)
  })
}
test('preflight migrates only a disposable snapshot and retains every original column value', async t => {
  const ops = api(), f = fixture(t)
  mkdirSync(f.root)
  const db = new DatabaseSync(join(f.root, 'taskforce.db'))
  db.exec("CREATE TABLE task(id INTEGER PRIMARY KEY,title TEXT NOT NULL,note TEXT,status TEXT,owner TEXT,created_at TEXT,updated_at TEXT); INSERT INTO task VALUES(7,'OPERATOR_SECRET_SENTINEL','original','claimed','worker','then','then')")
  db.close()
  const before = bytes(join(f.root, 'taskforce.db')), listing = readdirSync(f.directory)
  const result = safe(await ops.preflight({ root: f.root }))
  assert.equal(result.ok, true)
  assert.equal(result.rows_preserved, true)
  assert.equal(result.migration_required, true)
  assert.equal(bytes(join(f.root, 'taskforce.db')), before)
  assert.deepEqual(readdirSync(f.directory), listing)
})
test('failed preflight never mutates its original incompatible database', async t => {
  const ops = api(), f = fixture(t)
  mkdirSync(f.root)
  const db = new DatabaseSync(join(f.root, 'taskforce.db'))
  db.exec("CREATE TABLE task(id INTEGER PRIMARY KEY, title TEXT); INSERT INTO task VALUES(1,'OPERATOR_SECRET_SENTINEL')")
  db.close()
  const before = bytes(join(f.root, 'taskforce.db'))
  await assert.rejects(ops.preflight({ root: f.root }), { code: 'E_OPERATIONS_SCHEMA' })
  assert.equal(bytes(join(f.root, 'taskforce.db')), before)
})
test('restore validates a backup and stages unchanged audit with truthful relocation warning', async t => {
  const ops = api(), f = fixture(t); seed(f, true)
  const backup = join(f.directory, 'backup'), out = join(f.directory, 'restored')
  await ops.backup({ root: f.root, out: backup })
  const original = tableRows(f.store.handle)
  const result = safe(await ops.restore({ backup, out }))
  assert.equal(result.ok, true)
  assert.equal(result.reverification_required, true)
  assert.deepEqual(database(join(out, 'taskforce.db'), tableRows), original)
  assert.deepEqual(tableRows(f.store.handle), original)
  assert.equal(readFileSync(join(out, 'receipts', readdirSync(join(out, 'receipts'))[0])).length >= 0, true)
  await assert.rejects(ops.restore({ backup, out }), { code: 'E_OPERATIONS_EXISTS' })
})
for (const fault of ['database', 'log', 'traversal', 'duplicate', 'symlink', 'missing', 'extra']) {
  test('restore rejects ' + fault + ' backup faults without publishing a destination', async t => {
    const ops = api(), f = fixture(t); seed(f, true)
    const backup = join(f.directory, 'backup'), out = join(f.directory, 'restored')
    await ops.backup({ root: f.root, out: backup })
    const manifestPath = join(backup, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const log = manifest.files.find(file => file.path.endsWith('.stdout.log'))
    if (fault === 'database') writeFileSync(join(backup, 'taskforce.db'), SENTINEL)
    if (fault === 'log') writeFileSync(join(backup, log.path), 'tamper')
    if (fault === 'traversal') { log.path = '../foreign'; writeFileSync(manifestPath, JSON.stringify(manifest)) }
    if (fault === 'duplicate') { manifest.files.push(manifest.files[0]); writeFileSync(manifestPath, JSON.stringify(manifest)) }
    if (fault === 'symlink') {
      const other = join(f.directory, 'foreign'); writeFileSync(other, readFileSync(join(backup, log.path)))
      rmSync(join(backup, log.path)); symlinkSync(other, join(backup, log.path))
    }
    if (fault === 'missing') rmSync(join(backup, log.path))
    if (fault === 'extra') writeFileSync(join(backup, 'unexpected'), SENTINEL)
    await assert.rejects(ops.restore({ backup, out }), error => /^E_OPERATIONS_(MANIFEST|INTEGRITY|PATH|LOG)$/.test(error.code))
    assert.equal(existsSync(out), false)
    assert.equal(f.store.stats('run').tasks.total, 1)
  })
}
test('actual npm archive CLI executes help doctor backup preflight and restore with real SQLite', async t => {
  const ops = api(), f = fixture(t); seed(f, true)
  const archiveDir = join(f.directory, 'archive'); mkdirSync(archiveDir)
  const packed = JSON.parse(execFileSync('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', archiveDir],
    { cwd: ROOT, encoding: 'utf8', timeout: 20000 }))[0]
  execFileSync('tar', ['-xzf', join(archiveDir, packed.filename), '-C', archiveDir], { timeout: 20000 })
  const packageRoot = join(archiveDir, 'package')
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./operations'], './lib/operations/index.js')
  assert.equal(pkg.bin['imperator'], './tools/imperator.mjs')
  const cli = join(packageRoot, 'tools/imperator.mjs')
  const run = args => spawnSync(process.execPath, [cli, ...args], {
    cwd: f.directory, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, OPERATOR_SECRET_TEST: SENTINEL },
  })
  const help = run(['--help']); assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /doctor/)
  const commands = [
    ['doctor', '--root', f.root, '--json'],
    ['backup', '--root', f.root, '--out', join(f.directory, 'packed-backup'), '--json'],
    ['preflight', '--root', f.root, '--json'],
    ['restore', '--backup', join(f.directory, 'packed-backup'), '--out', join(f.directory, 'packed-restored'), '--json'],
  ]
  for (const command of commands) {
    const result = run(command)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(safe(JSON.parse(result.stdout)).ok, true)
    assert.doesNotMatch(result.stderr, /OPERATOR_SECRET_SENTINEL|imperator-operations-/)
  }
  for (const args of [[], ['doctor'], ['doctor', '--root', f.root, '--unsafe', SENTINEL],
    ['backup', '--root', f.root, '--out', f.root], ['doctor', '--root', f.root, '--root', f.root]]) {
    const result = run(args)
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stdout + result.stderr, /OPERATOR_SECRET_SENTINEL|imperator-operations-/)
    assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 8192)
  }
  assert.equal(lstatSync(join(f.directory, 'packed-restored', 'taskforce.db')).isFile(), true)
})

test('restored historical logs remain diagnosable and back up without accessing their old root', async t => {
  const ops = api(), f = fixture(t); seed(f, true)
  const backup = join(f.directory, 'first-backup'), restored = join(f.directory, 'restored')
  await ops.backup({ root: f.root, out: backup })
  const original = tableRows(f.store.handle)
  await ops.restore({ backup, out: restored })
  f.store.close(); rmSync(f.root, { recursive: true })
  const status = safe(await ops.doctor({ root: restored }))
  assert.equal(status.ok, true, 'restored log archives are valid even when original root no longer exists')
  assert.equal(status.counts.invalid_logs, 0)
  const second = join(f.directory, 'second-backup')
  assert.equal(safe(await ops.backup({ root: restored, out: second })).ok, true)
  assert.deepEqual(database(join(second, 'taskforce.db'), tableRows), original)
  const third = join(f.directory, 'restored-again')
  await ops.restore({ backup: second, out: third })
  assert.equal(safe(await ops.doctor({ root: third })).ok, true)
})
test('fresh verification at restored root permits backup of mixed historical and current receipt provenance', async t => {
  const ops = api(), f = fixture(t), task = seed(f, true)
  const { strictExecutionEvidence } = await import('../../lib/store/execution.js')
  const backup = join(f.directory, 'first-backup'), restored = join(f.directory, 'restored')
  await ops.backup({ root: f.root, out: backup })
  await ops.restore({ backup, out: restored })
  const resumed = new TaskforceStore(restored)
  t.after(() => resumed.close())
  const db = resumed.open()
  const row = db.prepare('SELECT * FROM task WHERE id=?').get(task.task_id)
  assert.throws(() => strictExecutionEvidence(db, restored, row), { code: 'E_VERIFICATION_RECEIPT' },
    'copying historical logs cannot revive strict acceptance')
  const caller = { isRoot: false, sessionId: 'worker' }
  const pending = resumed.recordExecution({ task_id: task.task_id, status: 'pending',
    command: 'node source.js', call_id: 'restored-call', root_call_id: 'restored-call', timeout_ms: 1000 }, 'run', caller)
  resumed.recordExecution({ task_id: task.task_id, receipt_id: pending.receipt_id,
    native_result: { isError: false, value: { kind: 'foreground', exitCode: 0, signal: null,
      timedOut: false, aborted: false, timeoutMs: 1000,
      stdout: { text: 'fresh', truncated: false }, stderr: { text: '', truncated: false } } } }, 'run', caller)
  assert.equal(strictExecutionEvidence(db, restored, row).receipt_id, pending.receipt_id)
  const second = join(f.directory, 'second-backup')
  assert.equal(safe(await ops.backup({ root: restored, out: second })).ok, true,
    'old receipt provenance must not prevent archiving fresh verification')
  assert.equal(safe(await ops.doctor({ root: restored })).ok, true)
  const rows = database(join(second, 'taskforce.db'), handle => handle.prepare('SELECT receipt_id,logs FROM execution_receipt ORDER BY id').all())
  assert.equal(rows.length, 2)
  assert.equal(JSON.parse(rows[0].logs).stdout.path, join(f.root, 'receipts', task.receipt_id + '.stdout.log'))
  assert.equal(JSON.parse(rows[1].logs).stdout.path, join(restored, 'receipts', pending.receipt_id + '.stdout.log'))
})
for (const fault of ['foreign-path', 'parent-escape', 'local-rewrite']) {
  test('restored audit refuses forged ' + fault + ' without normalizing stored provenance', async t => {
    const ops = api(), f = fixture(t); seed(f, true)
    const backup = join(f.directory, 'first-backup'), restored = join(f.directory, 'restored')
    await ops.backup({ root: f.root, out: backup }); await ops.restore({ backup, out: restored })
    const db = new DatabaseSync(join(restored, 'taskforce.db'))
    const row = db.prepare('SELECT receipt_id,logs FROM execution_receipt').get()
    const logs = JSON.parse(row.logs)
    logs.stdout.path = fault === 'local-rewrite' ? join(restored, 'receipts', row.receipt_id + '.stdout.log')
      : fault === 'foreign-path' ? join(f.directory, 'foreign', 'receipts', row.receipt_id + '.stdout.log')
      : f.root + '/receipts/../receipts/' + row.receipt_id + '.stdout.log'
    db.prepare('UPDATE execution_receipt SET logs=?').run(JSON.stringify(logs)); db.close()
    assert.equal((await ops.doctor({ root: restored })).ok, false)
    await assert.rejects(ops.backup({ root: restored, out: join(f.directory, 'rejected') }), { code: 'E_OPERATIONS_LOG' })
    assert.equal(existsSync(join(f.directory, 'rejected')), false)
  })
}
test('restore rejects a manifest that forges historical log provenance', async t => {
  const ops = api(), f = fixture(t); seed(f, true)
  const backup = join(f.directory, 'backup'), restored = join(f.directory, 'restored')
  await ops.backup({ root: f.root, out: backup })
  const path = join(backup, 'manifest.json'), manifest = JSON.parse(readFileSync(path, 'utf8'))
  manifest.files.find(file => file.path.endsWith('.stdout.log')).original_path = join(f.directory, 'forged', 'receipts', 'forged.stdout.log')
  writeFileSync(path, JSON.stringify(manifest))
  await assert.rejects(ops.restore({ backup, out: restored }), error => /^E_OPERATIONS_(MANIFEST|LOG)$/.test(error.code))
  assert.equal(existsSync(restored), false)
})
test('restored provenance metadata is required and rejects tampering and symlinks', async t => {
  const ops = api(), f = fixture(t); seed(f, true)
  const backup = join(f.directory, 'backup'), restored = join(f.directory, 'restored')
  await ops.backup({ root: f.root, out: backup }); await ops.restore({ backup, out: restored })
  const path = join(restored, 'receipt-provenance.json')
  assert.equal(existsSync(path), true, 'restore must preserve explicit archival provenance')
  const bytes = readFileSync(path), provenance = JSON.parse(bytes)
  provenance.files[0].original_path = join(f.directory, 'forged', provenance.files[0].path)
  writeFileSync(path, JSON.stringify(provenance))
  assert.equal((await ops.doctor({ root: restored })).ok, false)
  writeFileSync(path, bytes)
  const foreign = join(f.directory, 'foreign-provenance'); writeFileSync(foreign, bytes)
  rmSync(path); symlinkSync(foreign, path)
  assert.equal((await ops.doctor({ root: restored })).ok, false)
  await assert.rejects(ops.backup({ root: restored, out: join(f.directory, 'rejected') }), error => /^E_OPERATIONS_(PATH|LOG)$/.test(error.code))
})

for (const operation of ['backup', 'restore']) {
  test(operation + ' cannot revive historical strict receipts by returning an archive to an older root', async t => {
    const ops = api(), f = fixture(t), task = seed(f, true)
    const { strictExecutionEvidence } = await import('../../lib/store/execution.js')
    const first = join(f.directory, 'first-backup'), relocated = join(f.directory, 'relocated')
    await ops.backup({ root: f.root, out: first }); await ops.restore({ backup: first, out: relocated })
    const second = join(f.directory, 'second-backup')
    await ops.backup({ root: relocated, out: second })
    f.store.close(); rmSync(f.root, { recursive: true })
    await assert.rejects(async () => {
      if (operation === 'backup') await ops.backup({ root: relocated, out: f.root })
      else await ops.restore({ backup: second, out: f.root })
      // This branch proves why allowing the old root is unsafe: the original
      // owner/generation/source and now matching log paths revive acceptance.
      database(join(f.root, 'taskforce.db'), db => {
        const row = db.prepare('SELECT * FROM task WHERE id=?').get(task.task_id)
        assert.equal(strictExecutionEvidence(db, f.root, row).receipt_id, task.receipt_id)
      })
    }, { code: 'E_OPERATIONS_PATH' })
    assert.equal(existsSync(f.root), false)
    assert.equal((await ops.doctor({ root: relocated })).ok, true)
  })
}

// Frozen v0.3.2 schema from e0743f045afa0c4a81c3207c809c56ad49acaa5b.
// Built independently of the candidate store, including migrated task columns/views.
const V03_SCHEMA = `
CREATE TABLE IF NOT EXISTS task (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  note       TEXT,
  status     TEXT NOT NULL DEFAULT 'open',
  owner      TEXT,
  owner_session TEXT,
  run_id     TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fact (
  id               INTEGER PRIMARY KEY,
  task_id          INTEGER,
  kind             TEXT NOT NULL,
  statement        TEXT NOT NULL,
  evidence_path    TEXT,
  evidence_line    INTEGER,
  confidence       TEXT NOT NULL,
  created_by       TEXT,
  actor_session    TEXT,
  run_id           TEXT,
  resolves_fact_id INTEGER,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fact_task_id ON fact (task_id, id);

CREATE TABLE IF NOT EXISTS handoff (
  id         INTEGER PRIMARY KEY,
  task_id    INTEGER,
  from_child TEXT,
  to_child   TEXT,
  note       TEXT NOT NULL,
  run_id     TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_handoff_task_id ON handoff (task_id, id);

/* 旧视图：保持 7 列不变（历史读取方按列名取值），**不参与服务 API**。 */
CREATE VIEW IF NOT EXISTS v_task_board AS
  SELECT t.id AS id,
         t.title AS title,
         t.status AS status,
         t.owner AS owner,
         (SELECT COUNT(*) FROM fact f WHERE f.task_id = t.id) AS fact_count,
         (SELECT MAX(f.created_at) FROM fact f WHERE f.task_id = t.id) AS last_fact_at,
         (SELECT COUNT(*) FROM fact f WHERE f.task_id = t.id AND f.kind = 'blocker') AS blockers
    FROM task t;

ALTER TABLE task ADD COLUMN evidence_policy TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE task ADD COLUMN verification_files TEXT;
ALTER TABLE task ADD COLUMN verification_command TEXT;
ALTER TABLE task ADD COLUMN verification_cwd TEXT;
ALTER TABLE task ADD COLUMN evidence_generation INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_task_run_status ON task (run_id, status);
CREATE INDEX IF NOT EXISTS idx_fact_run ON fact (run_id, id);
CREATE INDEX IF NOT EXISTS idx_fact_blocker_run_id ON fact (run_id, id, task_id) WHERE kind='blocker';
CREATE INDEX IF NOT EXISTS idx_fact_resolves ON fact (resolves_fact_id);
CREATE INDEX IF NOT EXISTS idx_handoff_run ON handoff (run_id, id);

/* 带 run 的人工 SQL 投影（服务 API 之外的只读便利视图）。 */
DROP VIEW IF EXISTS v_run_board;
CREATE VIEW v_run_board AS
  SELECT t.run_id AS run_id,
         t.id AS id,
         t.title AS title,
         t.status AS status,
         t.owner AS owner,
         (SELECT COUNT(*) FROM fact f WHERE f.task_id = t.id AND f.run_id IS t.run_id) AS fact_count,
         (SELECT COUNT(*) FROM fact f WHERE f.task_id = t.id AND f.run_id IS t.run_id AND f.kind = 'blocker'
            AND NOT EXISTS (SELECT 1 FROM fact r WHERE (r.resolves_fact_id = f.id AND r.task_id = f.task_id AND r.run_id IS f.run_id AND r.kind = 'decision' AND r.confidence IN ('CONFIRMED', 'PLAUSIBLE')))) AS blockers_open
    FROM task t;


CREATE TABLE IF NOT EXISTS execution_receipt (
  id INTEGER PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  task_id INTEGER NOT NULL,
  run_id TEXT,
  evidence_generation INTEGER NOT NULL,
  owner_session TEXT NOT NULL,
  actor_session TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  verification_files TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  call_id TEXT NOT NULL,
  root_call_id TEXT NOT NULL,
  parent_call_id TEXT,
  timeout_ms INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  outcome TEXT,
  logs TEXT
);
CREATE INDEX IF NOT EXISTS idx_execution_task_run ON execution_receipt(task_id, run_id, id);
CREATE TABLE IF NOT EXISTS execution_waiver (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL,
  run_id TEXT,
  evidence_generation INTEGER NOT NULL,
  actor_session TEXT,
  reason TEXT NOT NULL,
  receipt_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_waiver_task_run ON execution_waiver(task_id, run_id, id);
`

async function unchangedDoctor(f, expectedCode) {
  f.store.close()
  const path = join(f.root, 'taskforce.db'), before = bytes(path), files = readdirSync(f.root)
  const result = safe(await api().doctor({ root: f.root }))
  assert.equal(result.ok, false)
  assert.ok(result.checks.some(check => check.code === expectedCode), JSON.stringify(result))
  assert.equal(bytes(path), before, 'doctor must not repair/migrate even incomplete v0.4 databases')
  assert.deepEqual(readdirSync(f.root), files)
  return result
}
test('doctor flags the real v0.3.2 schema while preflight rehearses its required v0.4 migration', async t => {
  const f = fixture(t)
  mkdirSync(f.root)
  const path = join(f.root, 'taskforce.db'), db = new DatabaseSync(path)
  db.exec(V03_SCHEMA)
  db.prepare("INSERT INTO task(title,status,run_id,owner_session,created_at,updated_at) VALUES(?,'open','run','owner','then','then')").run(SENTINEL)
  db.close()
  const before = bytes(path)
  const result = await unchangedDoctor(f, 'SCHEMA_UPGRADE_REQUIRED')
  assert.ok(!result.checks.some(check => check.code === 'DATABASE_OK'))
  const rehearsal = safe(await api().preflight({ root: f.root }))
  assert.equal(rehearsal.ok, true)
  assert.equal(rehearsal.migration_required, true)
  assert.equal(rehearsal.rows_preserved, true)
  assert.equal(bytes(path), before)
})
for (const [type, name] of [["TABLE","workflow"],["INDEX","idx_workflow_run"],["TABLE","task_dependency"],["INDEX","idx_dependency_prerequisite"],["TABLE","task_dependency_fence"],["TABLE","workflow_writer"],["TABLE","workflow_artifact"],["INDEX","idx_workflow_artifact"],["TABLE","workflow_review"],["INDEX","idx_workflow_review"],["TABLE","workflow_decision"],["INDEX","idx_workflow_decision"],["TABLE","lifecycle_event"],["INDEX","idx_lifecycle_run"],["INDEX","idx_lifecycle_caller"],["TABLE","control_operation"],["INDEX","idx_control_run"],["INDEX","idx_control_caller"],["TABLE","task_event"],["INDEX","idx_task_event_run"],["INDEX","idx_task_event_task"],["TABLE","task_checkpoint"],["INDEX","idx_checkpoint_run"],["INDEX","idx_checkpoint_task"],["TRIGGER","recovery_task_insert"],["TRIGGER","recovery_task_update"]]) {
  test('doctor detects missing required v0.4 ' + type.toLowerCase() + ' ' + name + ' without repair', async t => {
    const f = fixture(t); seed(f)
    f.store.handle.exec('DROP ' + type + ' ' + name)
    await unchangedDoctor(f, 'SCHEMA_UPGRADE_REQUIRED')
  })
}
for (const sql of [
  'ALTER TABLE workflow RENAME COLUMN plan_version TO obsolete_plan_version',
  'DROP INDEX idx_workflow_run; CREATE INDEX idx_workflow_run ON workflow(task_id)',
  'DROP TRIGGER recovery_task_insert; CREATE TRIGGER recovery_task_insert AFTER INSERT ON task BEGIN SELECT 1; END',
]) {
  test('doctor rejects malformed additive schema ' + sql.split(';')[0], async t => {
    const f = fixture(t); seed(f)
    f.store.handle.exec(sql)
    await unchangedDoctor(f, 'SCHEMA_UPGRADE_REQUIRED')
  })
}
function queue(f, task) {
  const scheduler = new TaskforceScheduler(f.store)
  const request = scheduler.enqueue({ request_key: 'queue', task_id: task.task_id, generation: 0,
    mode: 'read', kind: 'new', resources: [] }, 'run', { role: 'lead', sessionId: 'run' })
  return { scheduler, request }
}
for (const [type, name] of [['TABLE', 'scheduler_request'], ['TABLE', 'scheduler_decision'], ['INDEX', 'idx_scheduler_queue']]) {
  test('doctor detects incomplete initialized scheduler ' + name + ' without creating schema', async t => {
    const f = fixture(t), task = seed(f); queue(f, task)
    f.store.handle.exec('DROP ' + type + ' ' + name)
    await unchangedDoctor(f, 'SCHEMA_UPGRADE_REQUIRED')
  })
}
test('doctor accepts unused optional scheduler and initialized healthy queue without migration', async t => {
  const f = fixture(t), task = seed(f)
  assert.equal((await api().doctor({ root: f.root })).ok, true)
  assert.equal(f.store.handle.prepare("SELECT 1 FROM sqlite_schema WHERE name='scheduler_request'").get(), undefined)
  queue(f, task)
  assert.equal((await api().doctor({ root: f.root })).ok, true)
})
// Supply valid local audit rows, then alter only the identity under test.
function insertAudit(db, table, values) {
  const columns = db.prepare('PRAGMA table_info(' + table + ')').all()
  const row = Object.fromEntries(columns.filter(c => c.notnull && c.dflt_value === null)
    .map(c => [c.name, c.type === 'INTEGER' ? 1 : SENTINEL]))
  Object.assign(row, values)
  const names = Object.keys(row)
  return db.prepare('INSERT INTO ' + table + '(' + names.join(',') + ') VALUES(' + names.map(() => '?').join(',') + ')').run(...Object.values(row))
}
for (const table of ['task_event', 'task_checkpoint', 'control_operation', 'workflow', 'task_dependency',
  'task_dependency_fence', 'workflow_writer', 'workflow_artifact', 'workflow_review', 'workflow_decision']) {
  for (const fault of ['foreign-run', 'missing-task']) {
    test('doctor reports ' + table + ' ' + fault + ' scope corruption without leaking records', async t => {
      const f = fixture(t), task = seed(f, true)
      if (table === 'task_event') f.store.handle.exec('DELETE FROM task_event')
      const values = { task_id: task.task_id, run_id: 'run' }
      if (table === 'control_operation') Object.assign(values, { action: 'stop', status: 'pending' })
      if (table === 'workflow_artifact') values.receipt_id = task.receipt_id
      if (table === 'workflow_review') values.revision_id = artifact(f, task)
      if (['task_dependency', 'task_dependency_fence'].includes(table)) values.prerequisite_task_id = task.task_id
      insertAudit(f.store.handle, table, values)
      assert.equal((await api().doctor({ root: f.root })).ok, true, 'identity-consistent audit is readable')
      if (fault === 'foreign-run') f.store.handle.prepare('UPDATE ' + table + ' SET run_id=?').run(SENTINEL)
      else f.store.handle.prepare('UPDATE ' + table + ' SET task_id=?').run(99999)
      const result = await unchangedDoctor(f, 'SCOPE_INTEGRITY')
      assert.equal(result.counts.scope_anomalies, 1)
    })
  }
}
for (const table of ['task_dependency', 'task_dependency_fence']) {
  for (const fault of ['foreign-run', 'missing-target']) {
    test('doctor reports ' + table + ' ' + fault + ' prerequisite identity', async t => {
      const f = fixture(t), task = seed(f)
      const other = f.store.openTask({ title: SENTINEL }, 'other-run')
      insertAudit(f.store.handle, table, { task_id: task.task_id, run_id: 'run',
        prerequisite_task_id: fault === 'foreign-run' ? other.task_id : 99999 })
      const result = await unchangedDoctor(f, 'SCOPE_INTEGRITY')
      assert.equal(result.counts.scope_anomalies, 1)
    })
  }
}
for (const fault of ['foreign-run', 'missing-task', 'missing-reservation', 'foreign-reservation']) {
  test('doctor reports durable queue ' + fault + ' identity without changing dispatch state', async t => {
    const f = fixture(t), task = seed(f), { scheduler } = queue(f, task)
    if (fault === 'foreign-run') f.store.handle.prepare('UPDATE scheduler_request SET run_id=?').run(SENTINEL)
    if (fault === 'missing-task') f.store.handle.exec('UPDATE scheduler_request SET task_id=99999')
    if (fault.includes('reservation')) {
      const admitted = scheduler.admitNext({ request_key: 'admit' }, 'run', { role: 'lead', sessionId: 'run' })
      assert.equal(admitted.status, 'admitted')
      assert.equal((await api().doctor({ root: f.root })).ok, true)
      if (fault === 'missing-reservation') f.store.handle.exec("UPDATE scheduler_request SET reservation_id='missing'")
      else f.store.handle.prepare('UPDATE governor_reservation SET run_id=?').run(SENTINEL)
    }
    const result = await unchangedDoctor(f, 'SCOPE_INTEGRITY')
    assert.ok(result.counts.scope_anomalies >= 1)
  })
}
test('doctor allows unassigned controls and historical audit generation or owner values', async t => {
  const f = fixture(t), task = seed(f)
  insertAudit(f.store.handle, 'control_operation', { task_id: null, run_id: null, action: 'stop', status: 'pending' })
  insertAudit(f.store.handle, 'task_checkpoint', { task_id: task.task_id, run_id: 'run',
    evidence_generation: 900, owner_session: 'historical-owner' })
  const result = safe(await api().doctor({ root: f.root }))
  assert.equal(result.ok, true)
  assert.equal(result.counts.scope_anomalies, 0)
})

test('doctor requires the eager task-first blocker index without repairing it', async t => {
  const f = fixture(t); seed(f)
  assert.deepEqual(f.store.handle.prepare("PRAGMA index_info('idx_fact_blocker_task_run_id')").all().map(row => row.name),
    ['task_id', 'run_id', 'id'])
  f.store.handle.exec('DROP INDEX idx_fact_blocker_task_run_id')
  await unchangedDoctor(f, 'SCHEMA_UPGRADE_REQUIRED')
})

for (const [type, name] of [["TABLE","governor_run"],["TABLE","governor_reservation"],["TABLE","governor_retry_charge"],["INDEX","idx_governor_run"],["INDEX","idx_governor_active_task"],["TABLE","governor_hold"],["INDEX","idx_governor_resource"],["TABLE","governor_audit"]]) {
  test('doctor detects incomplete initialized governor ' + name + ' without creating schema', async t => {
    const f = fixture(t), task = seed(f)
    new TaskforceGovernor(f.store).reserve({ operation_key: 'admission', task_id: task.task_id,
      generation: 0, mode: 'read', kind: 'new', resources: ['workspace'] },
    'run', { role: 'lead', sessionId: 'run' })
    assert.equal((await api().doctor({ root: f.root })).ok, true)
    f.store.handle.exec('DROP ' + type + ' ' + name)
    await unchangedDoctor(f, 'SCHEMA_UPGRADE_REQUIRED')
  })
}
function artifact(f, task) {
  const receipt = f.store.handle.prepare('SELECT * FROM execution_receipt WHERE receipt_id=?').get(task.receipt_id)
  return Number(insertAudit(f.store.handle, 'workflow_artifact', {
    task_id: task.task_id, run_id: receipt.run_id, plan_version: 1,
    evidence_generation: receipt.evidence_generation, producer_session: receipt.owner_session,
    receipt_id: receipt.receipt_id, snapshot: receipt.snapshot, logs: receipt.logs,
  }).lastInsertRowid)
}
for (const reference of ['workflow', 'workflow_review', 'workflow_artifact']) {
  for (const fault of ['different-task', 'different-run', 'missing-target']) {
    test('doctor reports ' + reference + ' ' + fault + ' evidence reference without rewriting history', async t => {
      const f = fixture(t), first = seed(f, true), second = seed(f, true, fault === 'different-run' ? 'other-run' : 'run')
      const firstArtifact = artifact(f, first), secondArtifact = artifact(f, second)
      if (reference !== 'workflow_artifact') insertAudit(f.store.handle, reference,
        { task_id: first.task_id, run_id: 'run', revision_id: firstArtifact })
      assert.equal((await api().doctor({ root: f.root })).ok, true, 'valid reference identities')
      if (reference === 'workflow_artifact') f.store.handle.prepare('UPDATE workflow_artifact SET receipt_id=? WHERE id=?')
        .run(fault === 'missing-target' ? 'missing' : second.receipt_id, firstArtifact)
      else f.store.handle.prepare('UPDATE ' + reference + ' SET revision_id=? WHERE task_id=?')
        .run(fault === 'missing-target' ? 99999 : secondArtifact, first.task_id)
      const result = await unchangedDoctor(f, 'SCOPE_INTEGRITY')
      assert.equal(result.counts.scope_anomalies, 1)
    })
  }
}
test('doctor preserves historical workflow receipt/review identity across new owners and generations', async t => {
  const f = fixture(t), task = seed(f, true), oldRevision = artifact(f, task), currentRevision = artifact(f, task)
  insertAudit(f.store.handle, 'workflow', { task_id: task.task_id, run_id: 'run', revision_id: currentRevision })
  insertAudit(f.store.handle, 'workflow_review', { task_id: task.task_id, run_id: 'run', revision_id: oldRevision,
    evidence_generation: 10, plan_version: 2, reviewer_session: 'historical-reviewer' })
  f.store.handle.exec("UPDATE workflow_artifact SET producer_session='historical-producer',evidence_generation=9,plan_version=3")
  const result = safe(await api().doctor({ root: f.root }))
  assert.equal(result.ok, true)
  assert.equal(result.counts.scope_anomalies, 0)
})

for (const [table, field] of [['task', 'note'], ['fact', 'statement'], ['fact', 'evidence_path'],
  ['handoff', 'note'], ['execution_receipt', 'command'], ['execution_waiver', 'reason']]) {
  test('doctor and preflight reject missing runtime core column ' + table + '.' + field + ' without source changes', async t => {
    const f = fixture(t); seed(f)
    f.store.handle.exec('ALTER TABLE ' + table + ' DROP COLUMN ' + field)
    const before = bytes(f.store.dbPath), listing = readdirSync(f.root)
    const diagnosis = safe(await api().doctor({ root: f.root }))
    assert.equal(diagnosis.ok, false, 'missing runtime core column must not report DATABASE_OK')
    assert.ok(diagnosis.checks.some(check => check.code === 'SCHEMA_UPGRADE_REQUIRED'), JSON.stringify(diagnosis))
    assert.equal(bytes(f.store.dbPath), before)
    assert.deepEqual(readdirSync(f.root), listing)
    await assert.rejects(api().preflight({ root: f.root }), { code: 'E_OPERATIONS_SCHEMA' })
    assert.equal(bytes(f.store.dbPath), before, 'preflight must refuse an incompatible snapshot without repairing source')
    assert.deepEqual(readdirSync(f.root), listing)
  })
}

test('doctor and preflight reject a core view with table-shaped columns without repairing source', async t => {
  const f = fixture(t); seed(f)
  f.store.handle.exec('ALTER TABLE handoff RENAME TO handoff_rows; CREATE VIEW handoff AS SELECT * FROM handoff_rows')
  const before = bytes(f.store.dbPath), listing = readdirSync(f.root)
  const diagnosis = safe(await api().doctor({ root: f.root }))
  assert.equal(diagnosis.ok, false, 'runtime core objects must be real tables')
  assert.ok(diagnosis.checks.some(check => check.code === 'SCHEMA_UPGRADE_REQUIRED'), JSON.stringify(diagnosis))
  assert.equal(bytes(f.store.dbPath), before)
  assert.deepEqual(readdirSync(f.root), listing)
  await assert.rejects(api().preflight({ root: f.root }), { code: 'E_OPERATIONS_SCHEMA' })
  assert.equal(bytes(f.store.dbPath), before)
  assert.deepEqual(readdirSync(f.root), listing)
})
