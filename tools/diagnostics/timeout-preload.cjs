const { appendFileSync } = require('node:fs')
const { basename } = require('node:path')
const destination = process.env.IMPERATOR_TIMEOUT_AUDIT_FILE
const testFile = process.argv.length === 2 && process.argv.find(value => /[/\\][a-z0-9-]+\.test\.mjs$/.test(value))
if (destination && testFile) {
  const file = basename(testFile)
  const emit = phase => {
    try { appendFileSync(destination, JSON.stringify({
      at: Date.now(), pid: process.pid, ppid: process.ppid, file, phase,
      resources: process.getActiveResourcesInfo().sort(),
      cpu: process.cpuUsage(), rss: process.memoryUsage().rss,
    }) + '\n') } catch {}
  }
  emit('start')
  const timer = setInterval(() => emit('heartbeat'), 5000)
  timer.unref()
  process.on('beforeExit', () => emit('beforeExit'))
  process.on('exit', () => emit('exit'))
}
