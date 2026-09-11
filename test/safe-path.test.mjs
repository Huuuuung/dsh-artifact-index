// SPDX-License-Identifier: MIT
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve, sep } from 'node:path'

import { decodeSegment, isInsideRoot, isSafeName, resolveArtifact } from '../lib/safe-path.js'

const ROOT = resolve('/srv/artifacts')

test('isInsideRoot accepts the root itself and its descendants', () => {
  assert.equal(isInsideRoot(ROOT, ROOT), true)
  assert.equal(isInsideRoot(ROOT, join(ROOT, 'report.html')), true)
  assert.equal(isInsideRoot(ROOT, join(ROOT, 'nested', 'deep.txt')), true)
})

test('isInsideRoot rejects traversal and absolute outsiders', () => {
  assert.equal(isInsideRoot(ROOT, join(ROOT, '..', 'secrets.txt')), false)
  assert.equal(isInsideRoot(ROOT, join(ROOT, '..', '..', 'etc', 'passwd')), false)
  assert.equal(isInsideRoot(ROOT, resolve('/etc/passwd')), false)
})

test('isInsideRoot is not fooled by a sibling sharing the root prefix', () => {
  // The classic prefix bug: "/srv/artifacts-evil".startsWith("/srv/artifacts")
  // is true, so a naive implementation lets it through.
  const sibling = `${ROOT}${sep}evil` // placeholder to document intent
  assert.equal(sibling.startsWith(ROOT), true)
  assert.equal(isInsideRoot(ROOT, `${ROOT}-evil`), false)
  assert.equal(isInsideRoot(ROOT, `${ROOT}-evil${sep}x`), false)
})

test('isInsideRoot normalises redundant segments before comparing', () => {
  assert.equal(isInsideRoot(ROOT, join(ROOT, 'a', '..', 'b.txt')), true)
  assert.equal(isInsideRoot(ROOT, join(ROOT, '.', 'b.txt')), true)
})

test('isSafeName accepts ordinary artifact names', () => {
  for (const name of ['report.html', 'a.json', 'chat-export_2026.md', '图片.png', 'with space.txt']) {
    assert.equal(isSafeName(name), true, name)
  }
})

test('isSafeName rejects traversal, separators, dotfiles and junk', () => {
  const bad = [
    '..', '.', '', '.env', '.git',
    '../secrets', 'a/b', 'a\\b', '/etc/passwd', 'C:\\Windows\\win.ini',
    'nul\u0000byte', 'x'.repeat(256),
    null, undefined, 42, {}, [],
  ]
  for (const name of bad) {
    assert.equal(isSafeName(name), false, String(name))
  }
})

test('resolveArtifact returns the real path for a plain file', async () => {
  const real = resolve('/srv/artifacts/report.html')
  const result = await resolveArtifact(ROOT, 'report.html', {
    realpath: async (p) => (p === ROOT ? ROOT : real),
  })
  assert.equal(result, real)
})

test('resolveArtifact refuses a name that escapes the root lexically', async () => {
  let called = false
  const result = await resolveArtifact(ROOT, '../secrets.txt', {
    realpath: async () => {
      called = true
      return ROOT
    },
  })
  assert.equal(result, null)
  // Rejected before touching the filesystem at all.
  assert.equal(called, false)
})

test('resolveArtifact refuses a symlink pointing outside the root', async () => {
  // Lexically the candidate is inside ROOT, so only the realpath gate can
  // catch this one.
  const result = await resolveArtifact(ROOT, 'innocent.html', {
    realpath: async (p) => (p === ROOT ? ROOT : resolve('/etc/passwd')),
  })
  assert.equal(result, null)
})

test('resolveArtifact refuses when the realpath probe fails', async () => {
  const result = await resolveArtifact(ROOT, 'missing.html', {
    realpath: async () => {
      const err = new Error('ENOENT')
      err.code = 'ENOENT'
      throw err
    },
  })
  assert.equal(result, null)
})

test('resolveArtifact accepts a symlink that stays inside the root', async () => {
  const inside = resolve('/srv/artifacts/real.html')
  const result = await resolveArtifact(ROOT, 'link.html', {
    realpath: async (p) => (p === ROOT ? ROOT : inside),
  })
  assert.equal(result, inside)
})

test('decodeSegment decodes valid escapes and reports malformed ones', () => {
  assert.equal(decodeSegment('report%20one.html'), 'report one.html')
  assert.equal(decodeSegment('%E5%9B%BE%E7%89%87.png'), '图片.png')
  assert.equal(decodeSegment('..%2Fsecrets'), '../secrets')
  assert.equal(decodeSegment('%ZZ'), null)
  assert.equal(decodeSegment('%'), null)
})
