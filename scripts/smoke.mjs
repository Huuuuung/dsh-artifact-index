// SPDX-License-Identifier: MIT
/**
 * End-to-end smoke test against a REAL artifact directory.
 *
 * The unit and contract tests use temp directories. This one points the actual
 * handler at a real root, so it exercises the things a temp directory cannot:
 * the real file names an agent wrote, real mtimes, real sizes, and — most
 * usefully — the real path the plugin resolves through `$DSH_HOME`.
 *
 *   node scripts/smoke.mjs [root]
 *
 * Exits non-zero on the first failed expectation, so it can gate an install.
 */

import { createServer } from 'node:http'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { createHandler, resolveRoot } from '../lib/index.js'

const root = process.argv[2] ? resolve(process.argv[2]) : resolveRoot({})

const checks = []
function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail })
}

const handler = createHandler({
  root,
  maxItems: 500,
  maxFileBytes: 25 * 1024 * 1024,
  csp: 'sandbox',
  trustedHosts: [],
  log: (level, message) => console.log(`  [${level}] ${message}`),
})

const server = createServer((req, res) => handler(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

console.log(`root   : ${root}`)
console.log(`origin : ${origin}`)

let exitCode = 0
try {
  // Does the root exist at all? Worth stating explicitly, because a missing
  // root is the single most likely cause of an empty sidebar.
  const rootExists = await stat(root).then((s) => s.isDirectory()).catch(() => false)
  check('artifact root exists and is a directory', rootExists, root)

  const res = await fetch(`${origin}/report/?list=1`)
  check('index returns 200', res.status === 200, `status=${res.status}`)
  check('index is JSON', /application\/json/.test(res.headers.get('content-type') ?? ''))

  const body = await res.json()
  check('index has no `mine` key', !('mine' in body))
  check('index has count and items', typeof body.count === 'number' && Array.isArray(body.items))
  check('count matches items.length', body.count === body.items.length)
  check('no inline error', body.error === undefined, body.error ?? '')

  console.log(`\nitems (${body.count}):`)
  for (const item of body.items.slice(0, 20)) {
    console.log(`  ${item.ext.padEnd(6)} ${String(item.size).padStart(9)}  ${item.name}`)
  }
  if (body.count === 0) console.log('  (none)')

  // Every listed item must actually be fetchable. This is the check that
  // catches a url-building bug, which is invisible in the JSON alone.
  for (const item of body.items) {
    const fileRes = await fetch(`${origin}${item.url}`)
    check(`fetch ${item.name}`, fileRes.status === 200, `status=${fileRes.status}`)
    if (fileRes.status === 200) {
      const bytes = Buffer.from(await fileRes.arrayBuffer())
      check(`size matches for ${item.name}`, bytes.length === item.size, `${bytes.length} vs ${item.size}`)
      const type = fileRes.headers.get('content-type') ?? ''
      check(`content-type for ${item.name}`, type.length > 0, type)
    }
  }

  // Traversal must stay closed even against the real root.
  for (const path of ['/report/..%2F..%2F.credentials.yaml', '/report/%2Fetc%2Fpasswd']) {
    const bad = await fetch(`${origin}${path}`)
    check(`traversal blocked: ${path}`, [400, 404].includes(bad.status), `status=${bad.status}`)
  }

  const missing = await fetch(`${origin}/report/definitely-not-here.txt`)
  check('missing file is 404', missing.status === 404, `status=${missing.status}`)
} catch (err) {
  check('smoke run completed', false, err instanceof Error ? err.message : String(err))
} finally {
  await new Promise((r) => server.close(r))
}

console.log('')
let failed = 0
for (const { label, ok, detail } of checks) {
  if (!ok) failed++
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${label}${detail ? `  — ${detail}` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
if (failed > 0) exitCode = 1

process.exitCode = exitCode
