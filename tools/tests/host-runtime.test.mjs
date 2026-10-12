import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import * as runtime from '../host-runtime.mjs'
import { resolveInstallAnchor } from '../host-runtime.mjs'

const nativeEvents = ['unhandledRejection', 'uncaughtException', 'SIGTERM', 'SIGINT']
const listeners = emitter => nativeEvents.map(event => emitter.rawListeners(event))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('boot capture preserves the native continuation order before immediate shutdown', async () => {
  const emitter = new EventEmitter()
  let laterStartup = false
  const scope = runtime.createProfileLifecycle(() => {
    for (const event of nativeEvents) emitter.on(event, () => {})
    const work = Promise.resolve({ shutdown: { shutdown: async () => {} } })
    work.then(() => queueMicrotask(() => { laterStartup = true }))
    return work
  }, { emitter })
  try { await scope.runProfile({}); assert.equal(laterStartup, false, 'wrapper added a native startup continuation hop') }
  finally { await scope.shutdown(1); scope.dispose() }
})

test('boot scope preserves raw once wrappers, duplicate counts and later foreign listeners', async () => {
  const emitter = new EventEmitter(), duplicate = () => {}, later = () => {}
  for (const event of nativeEvents) { emitter.once(event, duplicate); emitter.on(event, duplicate); emitter.on(event, duplicate) }
  const before = listeners(emitter)
  const scope = runtime.createProfileLifecycle(async () => {
    for (const event of nativeEvents) emitter.on(event, duplicate)
    return { shutdown: { shutdown: async () => assert.deepEqual(listeners(emitter).map(row => row.length), [5, 5, 5, 5]) } }
  }, { emitter })
  await scope.runProfile({})
  for (const event of nativeEvents) emitter.on(event, later)
  await assert.rejects(scope.runProfile({}), /once/)
  await scope.shutdown(1)
  scope.dispose(); scope.dispose()
  assert.deepEqual(listeners(emitter), before.map(row => [...row, later]))
})

test('boot rejection captures zero or one native callback per event', async () => {
  for (const registered of [false, true]) {
    const emitter = new EventEmitter(), original = new Error('startup sentinel')
    const scope = runtime.createProfileLifecycle(async () => {
      if (registered) for (const event of nativeEvents) emitter.on(event, () => {})
      throw original
    }, { emitter })
    await assert.rejects(scope.runProfile({}), error => error === original)
    scope.dispose()
    assert.deepEqual(listeners(emitter), [[], [], [], []])
  }
})

test('abnormal capture retains the actual successful app and removes only proven callbacks after shutdown', async () => {
  const emitter = new EventEmitter(), ambiguous = [() => {}, () => {}]
  let stopped = false
  const app = { shutdown: { shutdown: async () => { stopped = true; assert.equal(emitter.listenerCount('SIGTERM'), 1) } } }
  const scope = runtime.createProfileLifecycle(async () => {
    for (const event of nativeEvents) emitter.on(event, event === nativeEvents[0] ? ambiguous[0] : () => {})
    emitter.on(nativeEvents[0], ambiguous[1])
    return app
  }, { emitter })
  assert.equal(await scope.runProfile({}), app)
  assert.throws(() => scope.dispose(), error => error instanceof AggregateError && error.errors.some(item => /pending/.test(item.message)))
  assert.equal(stopped, false)
  await scope.shutdown(1)
  await scope.whenDisposed
  assert.equal(stopped, true)
  assert.throws(() => scope.check(), /listener ownership/)
  assert.deepEqual(listeners(emitter), [ambiguous, [], [], []])
})

test('each original teardown promise retains callbacks through a timed-out earlier stage', async () => {
  const emitter = new EventEmitter(), handle = deferred(), app = deferred()
  let releases = 0
  const scope = runtime.createProfileLifecycle(async () => {
    for (const event of nativeEvents) emitter.on(event, () => {})
    return { shutdown: { shutdown: () => app.promise } }
  }, { emitter, release: () => { releases++ } })
  await scope.runProfile({})
  const handleWork = scope.teardown(() => handle.promise)
  const shutdownWork = scope.shutdown(1)
  await Promise.resolve()
  assert.throws(() => scope.dispose(), /pending/)
  app.resolve(); await shutdownWork
  assert.equal(releases, 0, 'later app settlement cannot settle an earlier handle')
  assert.deepEqual(listeners(emitter).map(row => row.length), [1, 1, 1, 1])
  handle.resolve(); await handleWork; await scope.whenDisposed
  assert.equal(releases, 1)
  assert.deepEqual(listeners(emitter), [[], [], [], []])
})

test('controlled fixture creation owns the environment before its first await and old disposal is inert',
  { skip: !process.env.DSH_INSTALL_ANCHOR && 'requires DSH_INSTALL_ANCHOR' }, async () => {
    const previousTemp = new Map(['TMPDIR', 'TMP', 'TEMP'].map(name => [name, process.env[name]]))
    const fixtureTmp = mkdtempSync(join(tmpdir(), 'taskforce-profile-owner-test-'))
    try {
      for (const name of previousTemp.keys()) process.env[name] = fixtureTmp
      const beforeHome = process.env.DSH_HOME, beforeTelemetry = process.env.DSH_TELEMETRY_DISABLED
      const pending = runtime.controlledProfile(process.env.DSH_INSTALL_ANCHOR, new URL('../..', import.meta.url).pathname)
      const ownedHome = process.env.DSH_HOME
      const homes = () => readdirSync(fixtureTmp).filter(name => name.startsWith('taskforce-host-')).sort()
      const beforeHomes = homes(), beforeListeners = listeners(process)
      let competitor
      try {
        assert.equal(beforeHomes.length, 1, 'the private fixture parent must contain exactly one active home')
        assert.equal(join(fixtureTmp, beforeHomes[0], 'home'), ownedHome,
          'the private fixture home must belong to the active profile')
        await assert.rejects(async () => {
          competitor = await runtime.controlledProfile(process.env.DSH_INSTALL_ANCHOR, new URL('../..', import.meta.url).pathname)
        }, /active controlled profile/)
        assert.equal(process.env.DSH_HOME, ownedHome)
        assert.deepEqual(homes(), beforeHomes)
        assert.deepEqual(listeners(process), beforeListeners)
      } finally { competitor?.dispose(); (await pending).dispose() }
      const old = await runtime.controlledProfile(process.env.DSH_INSTALL_ANCHOR, new URL('../..', import.meta.url).pathname)
      old.dispose()
      const current = await runtime.controlledProfile(process.env.DSH_INSTALL_ANCHOR, new URL('../..', import.meta.url).pathname)
      try { old.dispose(); assert.equal(process.env.DSH_HOME, join(current.root, 'home')) }
      finally { current.dispose() }
      assert.equal(process.env.DSH_HOME, beforeHome)
      assert.equal(process.env.DSH_TELEMETRY_DISABLED, beforeTelemetry)
      assert.deepEqual(homes(), [], 'controlled fixtures must remove their owned temporary homes')
    } finally {
      for (const [name, value] of previousTemp) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      rmSync(fixtureTmp, { recursive: true, force: true })
    }
  })

test('actual failed native profile boot restores the raw listener baseline',
  { skip: !process.env.DSH_INSTALL_ANCHOR && 'requires DSH_INSTALL_ANCHOR' }, async () => {
    const anchor = process.env.DSH_INSTALL_ANCHOR
    const fixture = await runtime.controlledProfile(anchor, new URL('../..', import.meta.url).pathname)
    const baseline = listeners(process)
    try {
      const run = fixture.runProfile ?? (await import(new URL('./lib/profile-boot.js', pathToFileURL(anchor)))).runProfile
      await assert.rejects(run({ environment: fixture.boot.loadLayeredEnv('dsh'), profile: 'web', patchFiles: [], get args() { throw new Error('native boot argument sentinel') } }))
    } finally { fixture.dispose() }
    assert.deepEqual(listeners(process), baseline)
    assert.equal(existsSync(fixture.root), false)
  })

test('real model setup and teardown retain primary errors plus fixture diagnostics and restore caller state',
  { skip: !process.env.DSH_INSTALL_ANCHOR && 'requires DSH_INSTALL_ANCHOR' }, () => {
    for (const mode of ['setup', 'teardown']) {
      const code = `import assert from 'node:assert/strict'; import { existsSync } from 'node:fs'; import { dirname } from 'node:path';
        const { createNativeHarness } = await import(${JSON.stringify(new URL('../verify-model.mjs', import.meta.url).href)});
        const primary = new Error('primary ${mode} sentinel'), extra = () => {};
        let beforeExit, emergency; const previous = process.exitCode;
        let inserted = false, profileRoot, stopped = false, requests = 0, streams = 0;
        const inject = (event, callback) => {
          if (event === 'exit' && callback.name === 'emergency') emergency = callback;
          if (event === 'SIGTERM' && !inserted) { inserted = true; process.on(event, extra); }
        };
        process.on('newListener', inject);
        let harness, failure;
        try {
          harness = await createNativeHarness({ installAnchor: process.env.DSH_INSTALL_ANCHOR,
            packageRoot: ${JSON.stringify(new URL('../..', import.meta.url).pathname)}, workspace: process.cwd(),
            provider: 'deepseek-official', model: 'deepseek-v4-pro', onRequest() { requests++; throw new Error('forbidden'); }
          }, { inspectNative({ ctx, handle }) {
            process.off('newListener', inject); profileRoot = dirname(process.env.DSH_HOME);
            assert.equal(typeof emergency, 'function');
            ctx.on('llm/stream', () => { streams++; throw new Error('forbidden'); }, { global: true, prepend: true });
            const dispose = ctx.fiber.dispose.bind(ctx.fiber);
            ctx.fiber.dispose = async () => {
              assert.ok(process.listenerCount('SIGTERM') >= 2); await dispose(); stopped = true;
              beforeExit = process.rawListeners('exit').filter(callback => callback !== emergency && callback.listener !== emergency);
            };
            ${mode === 'setup' ? 'throw primary;' : 'const release = handle.dispose.bind(handle); handle.dispose = async () => { await release(); throw primary; };'}
          } });
          await harness.dispose();
        } catch (error) { failure = error; }
        finally { process.off('newListener', inject); }
        const errors = error => error instanceof AggregateError ? error.errors.flatMap(errors) : [error];
        assert.ok(errors(failure).includes(primary), 'lost original failure');
        assert.ok(errors(failure).some(error => /listener ownership/.test(error.message)), 'lost fixture diagnostic');
        assert.equal(stopped, true); assert.equal(existsSync(profileRoot), false);
        assert.deepEqual(process.rawListeners('exit'), beforeExit); assert.equal(process.exitCode, previous);
        assert.equal(requests, 0); assert.equal(streams, 0); console.log('CALLER_ERRORS_PASS');`
      assert.match(execFileSync(process.execPath, ['--input-type=module', '-e', code],
        { encoding: 'utf8', timeout: 12_000, stdio: ['ignore', 'pipe', 'pipe'] }), /CALLER_ERRORS_PASS/)
    }
  })

test('paid handle deadline keeps native callbacks, environment and exit cleanup until actual settlement',
  { skip: !process.env.DSH_INSTALL_ANCHOR && 'requires DSH_INSTALL_ANCHOR', timeout: 13_000 }, () => {
    const code = `import assert from 'node:assert/strict'; import { existsSync } from 'node:fs'; import { dirname } from 'node:path';
      const { createNativeHarness } = await import(${JSON.stringify(new URL('../verify-model.mjs', import.meta.url).href)});
      const { controlledProfile } = await import(${JSON.stringify(new URL('../host-runtime.mjs', import.meta.url).href)});
      const events = ['unhandledRejection', 'uncaughtException', 'SIGTERM', 'SIGINT'];
      const snapshot = () => events.map(event => process.rawListeners(event));
      const baseline = snapshot(), previousHome = process.env.DSH_HOME, exit = process.exitCode;
      let exits, pendingExits, emergency;
      const observe = (event, callback) => { if (event === 'exit' && callback.name === 'emergency') emergency = callback; };
      process.on('newListener', observe);
      let release, profileRoot, requests = 0, streams = 0, appStopped = false;
      const pending = new Promise(done => { release = done; });
      const harness = await createNativeHarness({ installAnchor: process.env.DSH_INSTALL_ANCHOR,
        packageRoot: ${JSON.stringify(new URL('../..', import.meta.url).pathname)}, workspace: process.cwd(),
        provider: 'deepseek-official', model: 'deepseek-v4-pro', onRequest() { requests++; throw new Error('forbidden'); }
      }, { inspectNative({ ctx, handle }) {
        profileRoot = dirname(process.env.DSH_HOME);
        process.off('newListener', observe); assert.equal(typeof emergency, 'function');
        ctx.on('llm/stream', () => { streams++; throw new Error('forbidden'); }, { global: true, prepend: true });
        const handleDispose = handle.dispose.bind(handle);
        handle.dispose = async () => { await handleDispose(); await pending; };
        const appDispose = ctx.fiber.dispose.bind(ctx.fiber);
        ctx.fiber.dispose = async () => {
          await appDispose(); appStopped = true; pendingExits = process.rawListeners('exit');
          exits = pendingExits.filter(callback => callback !== emergency && callback.listener !== emergency);
        };
      } });
      const booted = snapshot(), ownedHome = process.env.DSH_HOME;
      const all = error => error instanceof AggregateError ? error.errors.flatMap(all) : [error];
      await assert.rejects(harness.dispose(), error => all(error).some(item => item.verificationCode === 'timeout') && all(error).some(item => /pending/.test(item.message)));
      assert.equal(appStopped, true, 'later app shutdown has actually completed');
      assert.deepEqual(snapshot(), booted); assert.equal(process.env.DSH_HOME, ownedHome);
      assert.equal(existsSync(profileRoot), true); assert.deepEqual(process.rawListeners('exit'), pendingExits);
      assert.equal(pendingExits.filter(callback => callback === emergency || callback.listener === emergency).length, 1);
      await assert.rejects(controlledProfile(process.env.DSH_INSTALL_ANCHOR, process.cwd()), /active controlled profile/);
      release(); await new Promise(done => setImmediate(done));
      assert.deepEqual(snapshot(), baseline); assert.equal(existsSync(profileRoot), false);
      assert.equal(process.env.DSH_HOME, previousHome); assert.deepEqual(process.rawListeners('exit'), exits);
      assert.equal(process.exitCode, exit); assert.equal(requests, 0); assert.equal(streams, 0);
      console.log('PAID_PENDING_SETTLED_PASS');`
    assert.match(execFileSync(process.execPath, ['--input-type=module', '-e', code],
      { encoding: 'utf8', timeout: 12_000, stdio: ['ignore', 'pipe', 'pipe'] }), /PAID_PENDING_SETTLED_PASS/)
  })

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

test('native failed or hung cleanup exits nonzero and deletes its disposable home',
  { skip: !process.env.DSH_INSTALL_ANCHOR && 'requires DSH_INSTALL_ANCHOR', timeout: 25_000 }, () => {
    for (const mode of ['reject', 'hang']) {
      const verifier = new URL('../verify-host.mjs', import.meta.url).href
      const code = `const { verifyHost } = await import(${JSON.stringify(verifier)});
        await verifyHost({ configureShutdown(app, root) {
          console.log('CLEANUP_ROOT=' + root);
          const dispose = app.ctx.fiber.dispose.bind(app.ctx.fiber);
          app.ctx.fiber.dispose = async () => {
            await dispose();
            ${mode === 'reject' ? "throw new Error('injected cleanup failure')" : 'return new Promise(() => {})'};
          };
        }});
        console.log('UNEXPECTED_SUCCESS');`
      let output
      try {
        assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', code],
          { encoding: 'utf8', timeout: 12_000, stdio: ['ignore', 'pipe', 'pipe'] }), error => {
          output = error.stdout
          assert.equal(error.status, 1, 'forced native cleanup must never exit zero')
          assert.doesNotMatch(output, /UNEXPECTED_SUCCESS|HOST_VERIFIED/)
          return true
        })
        const root = output.match(/^CLEANUP_ROOT=(.+)$/m)?.[1]
        assert.ok(root?.startsWith(join(tmpdir(), 'taskforce-host-')))
        assert.equal(existsSync(root), false, 'forced native cleanup leaked its home')
      } finally {
        const root = output?.match(/^CLEANUP_ROOT=(.+)$/m)?.[1]
        if (root?.startsWith(join(tmpdir(), 'taskforce-host-'))) rmSync(root, { recursive: true, force: true })
      }
    }
  })

test('model harness native rejected and hung disposal removes its home without model stages',
  { skip: !process.env.DSH_INSTALL_ANCHOR && 'requires DSH_INSTALL_ANCHOR', timeout: 25_000 }, () => {
    for (const mode of ['reject', 'hang']) {
      const code = `import { dirname } from 'node:path';
        const { createNativeHarness } = await import(${JSON.stringify(new URL('../verify-model.mjs', import.meta.url).href)});
        let requests = 0, streams = 0;
        const harness = await createNativeHarness({ installAnchor: process.env.DSH_INSTALL_ANCHOR,
          packageRoot: ${JSON.stringify(new URL('../..', import.meta.url).pathname)}, workspace: process.cwd(),
          provider: 'deepseek-official', model: 'deepseek-v4-pro', onRequest() { requests++; throw new Error('forbidden request'); }
        }, { inspectNative({ ctx }) {
          console.log('CLEANUP_ROOT=' + dirname(process.env.DSH_HOME));
          ctx.on('llm/stream', () => { streams++; throw new Error('forbidden stream'); }, { global: true, prepend: true });
          const baseline = ['unhandledRejection', 'uncaughtException', 'SIGTERM', 'SIGINT'].map(event => process.rawListeners(event));
          process.on('exit', () => console.log('EXIT_OBSERVED=' + JSON.stringify({ requests, streams,
            callbacksRetained: baseline.every((rows, i) => rows.every(fn => process.rawListeners(['unhandledRejection', 'uncaughtException', 'SIGTERM', 'SIGINT'][i]).includes(fn))) })));
          const dispose = ctx.fiber.dispose.bind(ctx.fiber);
          ctx.fiber.dispose = async () => { await dispose();
            ${mode === 'reject' ? "throw new Error('injected model cleanup failure')" : 'return new Promise(() => {})'};
          };
        } });
        await harness.dispose(); console.log('UNEXPECTED_SUCCESS');`
      let output
      try {
        assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', code],
          { encoding: 'utf8', timeout: 12_000, stdio: ['ignore', 'pipe', 'pipe'] }), error => {
          output = error.stdout
          assert.equal(error.status, 1)
          assert.doesNotMatch(output, /UNEXPECTED_SUCCESS/)
          return true
        })
        const root = output.match(/^CLEANUP_ROOT=(.+)$/m)?.[1]
        assert.ok(root?.startsWith(join(tmpdir(), 'taskforce-host-')))
        assert.deepEqual(JSON.parse(output.match(/^EXIT_OBSERVED=(.+)$/m)[1]), { requests: 0, streams: 0, callbacksRetained: true })
        assert.equal(existsSync(root), false, 'model harness forced native exit leaked its home')
      } finally {
        const root = output?.match(/^CLEANUP_ROOT=(.+)$/m)?.[1]
        if (root?.startsWith(join(tmpdir(), 'taskforce-host-'))) rmSync(root, { recursive: true, force: true })
      }
    }
  })
