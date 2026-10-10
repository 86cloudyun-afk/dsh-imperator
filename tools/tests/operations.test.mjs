import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
function seed(f, withReceipt = false) {
  const task = f.store.openTask(withReceipt ? {
    title: SENTINEL, evidence_policy: 'execution',
    verification_files: ['source.js'], verification_command: 'node source.js',
  } : { title: SENTINEL }, 'run', { isRoot: true, sessionId: 'run', cwd: f.workspace })
  if (withReceipt) {
    f.store.claimTask({ task_id: task.task_id, child_id: 'worker' }, 'run',
      { isRoot: false, sessionId: 'worker' }, 'worker')
    const receipt = f.store.recordExecution({ task_id: task.task_id, status: 'pending',
      command: 'node source.js', call_id: 'call', root_call_id: 'call', timeout_ms: 1000 },
    'run', { isRoot: false, sessionId: 'worker' })
    f.store.recordExecution({ task_id: task.task_id, receipt_id: receipt.receipt_id,
      native_result: { isError: false, value: { kind: 'foreground', exitCode: 0, signal: null,
        timedOut: false, aborted: false, timeoutMs: 1000,
        stdout: { text: SENTINEL, truncated: false }, stderr: { text: '', truncated: false } } } },
    'run', { isRoot: false, sessionId: 'worker' })
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
for (const fault of ['foreign-path', 'parent-escape']) {
  test('restored audit refuses forged ' + fault + ' without normalizing stored provenance', async t => {
    const ops = api(), f = fixture(t); seed(f, true)
    const backup = join(f.directory, 'first-backup'), restored = join(f.directory, 'restored')
    await ops.backup({ root: f.root, out: backup }); await ops.restore({ backup, out: restored })
    const db = new DatabaseSync(join(restored, 'taskforce.db'))
    const row = db.prepare('SELECT receipt_id,logs FROM execution_receipt').get()
    const logs = JSON.parse(row.logs)
    logs.stdout.path = fault === 'foreign-path' ? join(f.directory, 'foreign', 'receipts', row.receipt_id + '.stdout.log')
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
