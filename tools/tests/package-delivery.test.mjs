import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

test('the actual npm archive includes its verification commands and delivery guide', (t) => {
  const destination = mkdtempSync(join(tmpdir(), 'taskforce-pack-'))
  t.after(() => rmSync(destination, { recursive: true, force: true }))
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const output = execFileSync('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', destination],
    { cwd: root, encoding: 'utf8', timeout: 20_000 })
  const packed = JSON.parse(output)[0]
  assert.equal(packed.name, '@local/dsh-taskforce')
  const files = packed.files.map(file => file.path)
  for (const path of ['lib/index.js', 'lib/plugins/tool-events.mjs', 'cordis.patch.yml',
    'tools/verify-all.mjs', 'tools/verify-host.mjs', 'tools/verify-isolation.mjs', 'lib/plugins/scope-membership.mjs', 'tools/tests/integration-contract.test.mjs', 'docs/DELIVERY.md']) {
    assert(files.includes(path), `package is missing ${path}`)
  }
  assert(!files.some(path => /(^|\/)(\.git|node_modules|\.env)(\/|$)/.test(path)))
  assert(!files.some(path => /\.(db|sqlite|log|tgz)$/.test(path)))
})
