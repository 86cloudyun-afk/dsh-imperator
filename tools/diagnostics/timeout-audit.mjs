// Temporary diagnostic, NOT acceptance. Original verification deadline is unchanged.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, resolve, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const evidence = resolve(process.argv[2])
mkdirSync(evidence, { recursive: true })
const source = readFileSync(join(root, 'tools/verify-all.mjs'), 'utf8')
const match = source.match(/const TESTS = \[([\s\S]*?)\n\]/)
if (!match) throw new Error('Cannot locate exact verification test list')
const files = [...match[1].matchAll(/'([^']+\.test\.mjs)'/g)].map(match => match[1])
const allowed = new Set(files)
const emit = value => console.log(JSON.stringify({ diagnostic_only: true, acceptance: false, ...value }))
function processes() {
  const rows = []
  for (const directory of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      const raw = readFileSync('/proc/' + directory + '/stat', 'utf8')
      const end = raw.lastIndexOf(')')
      const parts = raw.slice(end + 2).split(' ')
      const args = readFileSync('/proc/' + directory + '/cmdline', 'utf8').split('\0')
      const file = args.map(value => basename(value)).find(value => allowed.has(value)) ?? null
      rows.push({ pid: Number(directory), ppid: Number(parts[1]), state: parts[0],
        utime_ticks: Number(parts[11]), stime_ticks: Number(parts[12]),
        file, wchan: readFileSync('/proc/' + directory + '/wchan', 'utf8').trim().slice(0,64) })
    } catch {}
  }
  return rows
}
for (let attempt = 1; attempt <= 3; attempt++) {
  const events = join(evidence, 'events-' + attempt + '.jsonl')
  const output = join(evidence, 'tap-' + attempt + '.log')
  writeFileSync(events, ''); writeFileSync(output, '')
  const started = Date.now()
  emit({ phase: 'suite_start', attempt, deadline_ms: 90000, files: files.length })
  const child = spawn(process.execPath, ['--require', join(root, 'tools/diagnostics/timeout-preload.cjs'),
    '--test', ...files.map(file => join(root, 'tools/tests', file))],
    { cwd: root, env: { ...process.env, IMPERATOR_TIMEOUT_AUDIT_FILE: events }, stdio: ['ignore','pipe','pipe'] })
  child.stdout.on('data', chunk => appendFileSync(output, chunk))
  child.stderr.on('data', chunk => appendFileSync(output, chunk))
  let timedOut = false, force
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    force = setTimeout(() => child.kill('SIGKILL'), 500)
  }, 90000)
  const monitor = setInterval(() => {
    const all = processes(), descendants = new Set([child.pid])
    for (let changed = true; changed;) {
      changed = false
      for (const row of all) if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid); changed = true
      }
    }
    const row = { phase: 'process_snapshot', attempt, elapsed_ms: Date.now() - started,
      processes: all.filter(row => descendants.has(row.pid)) }
    appendFileSync(join(evidence, 'processes.jsonl'), JSON.stringify(row) + '\n')
    emit(row)
  }, 2000)
  const outcome = await new Promise((resolveResult, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolveResult({ code, signal }))
  }).finally(() => { clearTimeout(timer); clearTimeout(force); clearInterval(monitor) })
  const records = readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  const timeline = [...new Set(records.map(row => row.pid))].map(pid => {
    const rows = records.filter(row => row.pid === pid), first = rows[0], last = rows.at(-1)
    return { file: first.file, pid, elapsed_ms: last.at - first.at, last_phase: last.phase,
      last_resources: last.resources, cpu: last.cpu }
  })
  const tap = readFileSync(output, 'utf8')
  emit({ phase: 'suite_end', attempt, elapsed_ms: Date.now() - started, timedOut, ...outcome,
    summaries: tap.split('\n').filter(line => /^# (tests|pass|fail|skipped|duration_ms) /.test(line)),
    timeline })
  if (timedOut || outcome.code !== 0) process.exitCode = 1
}
