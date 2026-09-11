// SPDX-License-Identifier: MIT
/**
 * Packaging and load-surface tests.
 *
 * These catch the failure mode this whole plugin exists in reaction to: a
 * bundle whose manifest, patch row and module exports disagree, which shows up
 * as a plugin that is installed but simply never activates.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (relative) => readFile(new URL(relative, import.meta.url), 'utf8')

test('the host module exposes the Cordis entry surface', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(mod.name, 'dsh-artifact-index')
  assert.deepEqual(mod.inject, ['webServer'])
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.createHandler, 'function')
  assert.equal(typeof mod.resolveRoot, 'function')
})

test('the support modules load and export their helpers', async () => {
  const safePath = await import('../lib/safe-path.js')
  assert.equal(typeof safePath.isInsideRoot, 'function')
  assert.equal(typeof safePath.isSafeName, 'function')
  assert.equal(typeof safePath.resolveArtifact, 'function')
  assert.equal(typeof safePath.decodeSegment, 'function')

  const scan = await import('../lib/scan.js')
  assert.equal(typeof scan.scan, 'function')
  assert.equal(typeof scan.toItem, 'function')
  assert.equal(typeof scan.extOf, 'function')

  const trust = await import('../lib/trust.js')
  assert.equal(typeof trust.isTrustedRequest, 'function')
  assert.equal(typeof trust.isLoopbackHost, 'function')
})

test('package.json declares a patch bundle and no lifecycle scripts', async () => {
  const pkg = JSON.parse(await read('../package.json'))
  assert.equal(pkg.name, 'dsh-artifact-index')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')

  // Zero install-time behaviour: this profile has been broken twice by pnpm's
  // build-script policy, so a new dependency here would be a regression.
  const scripts = pkg.scripts ?? {}
  for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) {
    assert.equal(lifecycle in scripts, false, lifecycle)
  }
  assert.equal(pkg.dependencies ?? null, null)
  assert.equal(pkg.optionalDependencies ?? null, null)

  // `files` must cover everything the loader reads at runtime.
  for (const entry of ['lib', 'cordis.patch.yml', 'README.md']) {
    assert.equal(pkg.files.includes(entry), true, entry)
  }
})

test('the patch row mounts this package by its published name', async () => {
  const pkg = JSON.parse(await read('../package.json'))
  const patch = await read('../cordis.patch.yml')

  // The `insert` row has to name the package exactly as it is installed, or the
  // loader resolves nothing and the plugin silently never mounts.
  assert.match(patch, /- insert:/)
  assert.match(patch, new RegExp(`id: dsh-artifact-index`))
  assert.match(patch, new RegExp(`name: '${pkg.name}'`))
})

test('resolveRoot prefers config, then env, then $DSH_HOME/artifacts', async () => {
  const { resolveRoot } = await import('../lib/index.js')
  const previousEnv = process.env.DSH_ARTIFACT_INDEX_ROOT
  const previousHome = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = process.platform === 'win32' ? 'D:\\FakeHome' : '/fake/home'
    delete process.env.DSH_ARTIFACT_INDEX_ROOT

    const fallback = resolveRoot({})
    assert.match(fallback, /artifacts$/)

    process.env.DSH_ARTIFACT_INDEX_ROOT = process.platform === 'win32' ? 'D:\\FromEnv' : '/from/env'
    assert.equal(resolveRoot({}), process.platform === 'win32' ? 'D:\\FromEnv' : '/from/env')

    // Explicit config wins over the environment.
    const configured = process.platform === 'win32' ? 'D:\\FromConfig' : '/from/config'
    assert.equal(resolveRoot({ root: configured }), configured)

    // Blank config falls back to the environment rather than producing a
    // relative path.
    assert.equal(resolveRoot({ root: '   ' }), process.env.DSH_ARTIFACT_INDEX_ROOT)
  } finally {
    if (previousEnv === undefined) delete process.env.DSH_ARTIFACT_INDEX_ROOT
    else process.env.DSH_ARTIFACT_INDEX_ROOT = previousEnv
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

/**
 * Drive the real `apply` with a stub context shaped like the host's.
 *
 * `dsh --dump-config` proves the patch row composes; it does NOT prove that
 * `apply` runs, that it returns a disposer from `ctx.effect`, or that the route
 * it registers is well formed. A plugin that is mounted but silently never
 * activates is the exact failure mode this profile has hit twice, so the
 * assembly is asserted directly.
 */
test('apply registers exactly one prefix route and returns a disposer', async () => {
  const { apply } = await import('../lib/index.js')

  const registrations = []
  const effectLabels = []
  let disposed = false

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(callback, label) {
      effectLabels.push(label)
      const disposer = callback()
      // The host disposes routes by calling what the callback returned; a
      // callback that returns nothing would leak the route across a reload.
      assert.equal(typeof disposer, 'function', 'effect callback must return a disposer')
      return disposer
    },
    webServer: {
      register(options) {
        registrations.push(options)
        // Mirrors the host seam: register returns the disposer.
        return () => {
          disposed = true
        }
      },
    },
  }

  apply(ctx, { root: '/tmp/whatever' })

  assert.equal(registrations.length, 1)
  const [route] = registrations
  assert.equal(route.kind, 'prefix')
  // No trailing slash: callers request `/report/`, which must fall inside the
  // prefix rather than being an exact-match near miss.
  assert.equal(route.path, '/report')
  assert.equal(typeof route.handler, 'function')
  assert.equal(effectLabels.length, 1)
  assert.equal(disposed, false)
})

test('apply does not read an undeclared config service from the context', async () => {
  const { apply } = await import('../lib/index.js')
  const context = new Proxy({
    logger: { info() {}, warn() {}, error() {} },
    effect: (callback) => callback(),
    webServer: { register: () => () => {} },
  }, {
    get(target, property, receiver) {
      if (property === 'config') throw new Error('cannot get property "config" without inject')
      return Reflect.get(target, property, receiver)
    },
  })

  assert.doesNotThrow(() => apply(context, { root: '/tmp/whatever' }))
})

test('the route apply registers actually serves the index contract', async () => {
  const { apply } = await import('../lib/index.js')
  const { createServer } = await import('node:http')
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const root = await mkdtemp(join(tmpdir(), 'dsh-artifact-index-apply-'))
  try {
    await writeFile(join(root, 'probe.md'), '# probe')

    let registered
    const ctx = {
      logger: { info() {}, warn() {}, error() {} },
      effect: (callback) => callback(),
      webServer: {
        register(options) {
          registered = options
          return () => {}
        },
      },
    }
    apply(ctx, { root })
    assert.equal(typeof registered?.handler, 'function')

    // End-to-end through the handler that `apply` registered — not through
    // createHandler directly, so a mis-wired closure would be caught here.
    const server = createServer((req, res) => registered.handler(req, res))
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    try {
      const origin = `http://127.0.0.1:${server.address().port}`
      const body = await (await fetch(`${origin}/report/?list=1`)).json()
      assert.equal(body.count, 1)
      assert.equal(body.items[0].name, 'probe.md')
      assert.equal(body.items[0].url, '/report/probe.md')

      const file = await fetch(`${origin}${body.items[0].url}`)
      assert.equal(file.status, 200)
      assert.equal(await file.text(), '# probe')
    } finally {
      await new Promise((r) => server.close(r))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
