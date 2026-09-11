// SPDX-License-Identifier: MIT
/**
 * Scan-layer unit tests, with the filesystem injected so every branch
 * (unreadable root, vanished file, truncation) is reachable deterministically.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_MAX_ITEMS, compareNewestFirst, describeRootError, extOf, scan, toItem } from '../lib/scan.js'

/** Build a `readdir`-shaped implementation from a list of entries. */
function fakeReaddir(entries) {
  return async () => entries.map((name) => ({
    name,
    isFile: () => !name.endsWith('/'),
    isDirectory: () => name.endsWith('/'),
  }))
}

/** Build a `stat`-shaped implementation from a name → stats map. */
function fakeStat(table) {
  return async (path) => {
    const name = path.split('/').pop()
    const entry = table[name]
    if (entry === undefined) {
      const err = new Error('ENOENT')
      err.code = 'ENOENT'
      throw err
    }
    return { size: entry.size ?? 10, mtimeMs: entry.mtimeMs ?? 0, isFile: () => entry.file !== false }
  }
}

test('extOf is case-insensitive and needs a real extension', () => {
  assert.equal(extOf('a.MD'), 'md')
  assert.equal(extOf('a.PnG'), 'png')
  assert.equal(extOf('a.tar.gz'), null) // 'gz' is not on the allowlist
  assert.equal(extOf('noext'), null)
  assert.equal(extOf('.env'), null)
  assert.equal(extOf('trailing.'), null)
  assert.equal(extOf('script.exe'), null)
  assert.equal(extOf(''), null)
  assert.equal(extOf(null), null)
})

test('toItem builds the exact contract fields', () => {
  const item = toItem('report.html', { size: 123, mtimeMs: 1_700_000_000_500 })
  assert.deepEqual(item, {
    name: 'report.html',
    url: '/report/report.html',
    ext: 'html',
    size: 123,
    mtime: 1_700_000_000,
  })
})

test('toItem percent-encodes names in the url', () => {
  assert.equal(toItem('a b#c?.txt', { size: 1, mtimeMs: 0 }).url, '/report/a%20b%23c%3F.txt')
  assert.equal(toItem('图片.png', { size: 1, mtimeMs: 0 }).url, `/report/${encodeURIComponent('图片.png')}`)
})

test('toItem returns null for non-listable names', () => {
  assert.equal(toItem('script.exe', { size: 1, mtimeMs: 0 }), null)
  assert.equal(toItem('.env', { size: 1, mtimeMs: 0 }), null)
})

test('compareNewestFirst sorts by mtime then name', () => {
  const items = [
    { name: 'b.txt', mtime: 10 },
    { name: 'a.txt', mtime: 10 },
    { name: 'c.txt', mtime: 20 },
  ]
  assert.deepEqual(items.sort(compareNewestFirst).map((i) => i.name), ['c.txt', 'a.txt', 'b.txt'])
})

test('scan returns items sorted, filtered and mapped', async () => {
  const result = await scan('/root', {
    deps: {
      readdir: fakeReaddir(['old.txt', '.secret.md', 'folder.md/', 'new.md', 'script.exe']),
      stat: fakeStat({
        'old.txt': { size: 1, mtimeMs: 1000 },
        'new.md': { size: 2, mtimeMs: 3000 },
      }),
    },
  })
  assert.equal(result.error, undefined)
  assert.equal(result.count, 2)
  assert.deepEqual(result.items.map((i) => i.name), ['new.md', 'old.txt'])
})

test('scan skips a file that vanished between readdir and stat', async () => {
  const result = await scan('/root', {
    deps: {
      readdir: fakeReaddir(['gone.txt', 'here.txt']),
      stat: fakeStat({ 'here.txt': { size: 1, mtimeMs: 1 } }),
    },
  })
  assert.deepEqual(result.items.map((i) => i.name), ['here.txt'])
})

test('scan skips an entry that turned out to be a directory', async () => {
  const result = await scan('/root', {
    deps: {
      readdir: fakeReaddir(['dir.txt', 'file.txt']),
      stat: fakeStat({
        'dir.txt': { size: 0, mtimeMs: 1, file: false },
        'file.txt': { size: 1, mtimeMs: 1 },
      }),
    },
  })
  assert.deepEqual(result.items.map((i) => i.name), ['file.txt'])
})

test('scan truncates at maxItems and reports it through onWarn', async () => {
  const names = ['a.txt', 'b.txt', 'c.txt']
  const warnings = []
  const result = await scan('/root', {
    maxItems: 2,
    deps: {
      readdir: fakeReaddir(names),
      stat: fakeStat({ 'a.txt': { mtimeMs: 3 }, 'b.txt': { mtimeMs: 2 }, 'c.txt': { mtimeMs: 1 } }),
      onWarn: (m) => warnings.push(m),
    },
  })
  assert.equal(result.count, 2)
  assert.deepEqual(result.items.map((i) => i.name), ['a.txt', 'b.txt'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /truncated at maxItems=2/)
})

test('scan turns an unreadable root into an inline error', async () => {
  for (const [code, pattern] of [
    ['ENOENT', /does not exist/],
    ['EACCES', /not readable/],
    ['ENOTDIR', /not a directory/],
  ]) {
    const result = await scan('/root', {
      deps: {
        readdir: async () => {
          const err = new Error(code)
          err.code = code
          throw err
        },
        stat: fakeStat({}),
      },
    })
    assert.equal(result.count, 0)
    assert.deepEqual(result.items, [])
    assert.match(result.error, pattern, code)
  }
})

test('describeRootError falls back to the message for unknown codes', () => {
  assert.match(describeRootError('/r', new Error('boom')), /cannot read artifact root \/r: boom/)
  assert.match(describeRootError('/r', 'plain string'), /plain string/)
})

test('DEFAULT_MAX_ITEMS is a positive integer', () => {
  assert.equal(Number.isInteger(DEFAULT_MAX_ITEMS), true)
  assert.equal(DEFAULT_MAX_ITEMS > 0, true)
})
