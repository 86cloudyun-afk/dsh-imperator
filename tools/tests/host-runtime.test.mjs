import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveInstallAnchor } from '../host-runtime.mjs'

function installation(t) {
  const root = mkdtempSync(join(tmpdir(), 'taskforce-install-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const modules = join(root, 'versioned/lib/node_modules')
  const pkg = join(modules, '@deepseek-ai/dsh')
  const anchor = join(pkg, 'package.json')
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  mkdirSync(join(pkg, 'node_modules'))
  writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }))
  const launcher = join(pkg, 'lib/bin.js')
  writeFileSync(launcher, '#!/usr/bin/env node\n')
  chmodSync(launcher, 0o755)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  symlinkSync(launcher, join(bin, 'dsh'))
  return { root, pkg, modules, bin, anchor }
}

test('resolves explicit npm anchors, legacy modules directories and versioned PATH symlinks', (t) => {
  const fixture = installation(t)
  assert.equal(resolveInstallAnchor({ installAnchor: fixture.anchor }), fixture.anchor)
  assert.equal(resolveInstallAnchor({ installDir: fixture.modules }), fixture.anchor)
  assert.equal(resolveInstallAnchor({ installDir: join(fixture.pkg, 'node_modules') }), fixture.anchor)
  // Exercise PATH lookup independently of any inherited explicit env anchor.
  const previous = process.env.DSH_INSTALL_ANCHOR
  delete process.env.DSH_INSTALL_ANCHOR
  try { assert.equal(resolveInstallAnchor({ path: fixture.bin }), fixture.anchor) }
  finally { if (previous !== undefined) process.env.DSH_INSTALL_ANCHOR = previous }
})

test('missing explicit paths fail even when PATH or an env anchor could succeed', (t) => {
  const fixture = installation(t)
  const previous = process.env.DSH_INSTALL_ANCHOR
  process.env.DSH_INSTALL_ANCHOR = fixture.anchor
  try {
    assert.throws(() => resolveInstallAnchor({ installAnchor: join(fixture.root, 'missing'), path: fixture.bin }), /UNVERIFIED/)
    assert.throws(() => resolveInstallAnchor({ installDir: join(fixture.root, 'missing'), path: fixture.bin }), /UNVERIFIED/)
  } finally {
    if (previous === undefined) delete process.env.DSH_INSTALL_ANCHOR
    else process.env.DSH_INSTALL_ANCHOR = previous
  }
})

test('a different dsh package cannot count as DeepSeek Harness', (t) => {
  const fixture = installation(t)
  writeFileSync(fixture.anchor, JSON.stringify({ name: 'dancers-shell' }))
  assert.throws(() => resolveInstallAnchor({ installAnchor: fixture.anchor }), /UNVERIFIED/)
})

test('real native resolution rejects missing Config fields, bad structure and missing modules',
  { skip: !process.env.DSH_INSTALL_ANCHOR && 'requires DSH_INSTALL_ANCHOR' }, () => {
    const verifier = new URL('../verify-preset.mjs', import.meta.url).href
    const code = `import assert from 'node:assert/strict';
      const { verifyPreset } = await import(${JSON.stringify(verifier)});
      const { TASKFORCE_DEFINITION } = await import(${JSON.stringify(new URL('../../lib/preset.js', import.meta.url).href)});
      assert.equal((await verifyPreset()).ok, true);
      const bad = structuredClone(TASKFORCE_DEFINITION);
      bad.plugins.find(row => row.id === 'tool-todo').config = {};
      const config = await verifyPreset({ definition: bad });
      assert.equal(config.ok, false); assert.match(config.problems.join(' '), /tool-todo.*allowParallelInProgress/s);
      const missing = structuredClone(TASKFORCE_DEFINITION);
      missing.plugins.push({id:'missing', name:'@local/no-such-module'});
      assert.equal((await verifyPreset({definition:missing})).ok, false);
      const structure = structuredClone(TASKFORCE_DEFINITION);
      structure.plugins.push({name:'@local/no-id'});
      assert.equal((await verifyPreset({definition:structure})).ok, false);
      console.log('NATIVE_CONFIG_NEGATIVES_PASS');`
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', code],
      { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
    assert.match(output, /NATIVE_CONFIG_NEGATIVES_PASS/)
  })
