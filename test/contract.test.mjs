// SPDX-License-Identifier: MIT
/**
 * Contract tests: the JSON index and the file route, exercised through a real
 * HTTP server against a real temp directory.
 *
 * These are the tests that matter most — the whole point of this plugin is to
 * satisfy an interface owned by `dsh-artifacts`, and a shape mismatch is
 * invisible until the sidebar shows an error.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHandler } from '../lib/index.js'

/** Spin up the handler on an ephemeral loopback port. */
async function withServer(options, fn) {
  const handler = createHandler({
    maxItems: 500,
    maxFileBytes: 25 * 1024 * 1024,
    csp: 'sandbox',
    trustedHosts: [],
    log: () => {},
    ...options,
  })
  const server = createServer((req, res) => handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn({ origin: `http://127.0.0.1:${port}`, port })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** Temp directory with a small, deterministic set of artifacts. */
async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifact-index-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Set mtimes so ordering assertions are not clock-dependent. */
async function touch(path, secondsAgo) {
  const when = new Date(Date.now() - secondsAgo * 1000)
  await utimes(path, when, when)
}

test('index returns the contract shape with no `mine` key', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'a.txt'), 'hello')
    await withServer({ root }, async ({ origin }) => {
      const res = await fetch(`${origin}/report/?list=1`)
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') ?? '', /application\/json/)
      const body = await res.json()

      assert.equal(body.count, 1)
      assert.equal(Array.isArray(body.items), true)
      assert.equal(body.items.length, 1)

      const [item] = body.items
      assert.deepEqual(Object.keys(item).sort(), ['ext', 'mtime', 'name', 'size', 'url'])
      assert.equal(item.name, 'a.txt')
      assert.equal(item.url, '/report/a.txt')
      assert.equal(item.ext, 'txt')
      assert.equal(item.size, 5)
      assert.equal(Number.isInteger(item.mtime), true)

      // The client hides its "This chat / All" toggle when `mine` is absent.
      assert.equal('mine' in body, false)
      assert.equal('mine' in item, false)
    })
  })
})

test('index also answers at the prefix root and ignores ?session', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'a.txt'), 'x')
    await withServer({ root }, async ({ origin }) => {
      for (const path of ['/report', '/report/', '/report/?list=1&session=abc123']) {
        const body = await (await fetch(`${origin}${path}`)).json()
        assert.equal(body.count, 1, path)
      }
    })
  })
})

test('index lists newest first and ties break by name', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'old.txt'), '1')
    await writeFile(join(root, 'newest.txt'), '2')
    await writeFile(join(root, 'middle.txt'), '3')
    await touch(join(root, 'old.txt'), 300)
    await touch(join(root, 'newest.txt'), 0)
    await touch(join(root, 'middle.txt'), 100)

    await withServer({ root }, async ({ origin }) => {
      const { items } = await (await fetch(`${origin}/report/`)).json()
      assert.deepEqual(items.map((i) => i.name), ['newest.txt', 'middle.txt', 'old.txt'])
    })
  })
})

test('index skips dotfiles, directories, symlink-less non-files and unknown types', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'keep.md'), 'x')
    await writeFile(join(root, '.hidden.md'), 'x')
    await writeFile(join(root, 'script.exe'), 'x')
    await writeFile(join(root, 'noext'), 'x')
    await mkdir(join(root, 'folder.md'))

    await withServer({ root }, async ({ origin }) => {
      const { items, count } = await (await fetch(`${origin}/report/`)).json()
      assert.deepEqual(items.map((i) => i.name), ['keep.md'])
      assert.equal(count, 1)
    })
  })
})

test('index respects maxItems', async () => {
  await withRoot(async (root) => {
    for (let i = 0; i < 5; i++) await writeFile(join(root, `f${i}.txt`), 'x')
    await withServer({ root, maxItems: 2 }, async ({ origin }) => {
      const body = await (await fetch(`${origin}/report/`)).json()
      assert.equal(body.items.length, 2)
      assert.equal(body.count, 2)
    })
  })
})

test('index reports a missing root as an inline error, not a crash', async () => {
  const root = join(tmpdir(), 'dsh-artifact-index-does-not-exist-xyz')
  await withServer({ root }, async ({ origin }) => {
    const res = await fetch(`${origin}/report/`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.count, 0)
    assert.deepEqual(body.items, [])
    assert.match(body.error, /does not exist/)
  })
})

test('file route serves bytes with the right content type', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'report.md'), '# title\n中文内容\n', 'utf8')
    await withServer({ root }, async ({ origin }) => {
      const res = await fetch(`${origin}/report/report.md`)
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') ?? '', /text\/markdown/)
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(res.headers.get('cache-control'), 'no-store')
      assert.equal(await res.text(), '# title\n中文内容\n')
    })
  })
})

test('file route percent-decodes names, including CJK', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, '图片.png'), 'PNGDATA')
    await withServer({ root }, async ({ origin }) => {
      const res = await fetch(`${origin}/report/${encodeURIComponent('图片.png')}`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'image/png')
      assert.equal(await res.text(), 'PNGDATA')
    })
  })
})

test('HTML artifacts carry the sandbox CSP by default', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'page.html'), '<script>alert(1)</script>')
    await withServer({ root }, async ({ origin }) => {
      const res = await fetch(`${origin}/report/page.html`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-security-policy'), 'sandbox')
    })
  })
})

test('csp config can widen to allow-scripts or disable the header', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'page.html'), '<b>x</b>')
    await withServer({ root, csp: 'sandbox-scripts' }, async ({ origin }) => {
      const res = await fetch(`${origin}/report/page.html`)
      assert.equal(res.headers.get('content-security-policy'), 'sandbox allow-scripts')
    })
    await withServer({ root, csp: 'none' }, async ({ origin }) => {
      const res = await fetch(`${origin}/report/page.html`)
      assert.equal(res.headers.get('content-security-policy'), null)
    })
  })
})

test('non-HTML artifacts do not get a CSP header', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'a.json'), '{}')
    await withServer({ root }, async ({ origin }) => {
      const res = await fetch(`${origin}/report/a.json`)
      assert.equal(res.headers.get('content-security-policy'), null)
    })
  })
})

test('file route enforces maxFileBytes with 413', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(2048))
    await withServer({ root, maxFileBytes: 1024 }, async ({ origin }) => {
      const res = await fetch(`${origin}/report/big.txt`)
      assert.equal(res.status, 413)
      const body = await res.json()
      assert.match(body.error, /too large/)
    })
  })
})

test('file route rejects traversal attempts', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'inside.txt'), 'x')
    await withServer({ root }, async ({ origin }) => {
      const attempts = [
        '/report/..%2Foutside.txt',
        '/report/%2e%2e%2Foutside.txt',
        '/report/..%5Coutside.txt',
        '/report/%2Fetc%2Fpasswd',
      ]
      for (const path of attempts) {
        const res = await fetch(`${origin}${path}`)
        // 400 for a rejected name; 404 once URL normalisation moved the path
        // out of the /report prefix entirely.
        assert.equal([400, 404].includes(res.status), true, `${path} → ${res.status}`)
      }
    })
  })
})

test('file route 404s for missing files, unknown types and directories', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'script.exe'), 'MZ')
    await mkdir(join(root, 'folder.txt'))
    await withServer({ root }, async ({ origin }) => {
      for (const path of ['/report/nope.txt', '/report/script.exe', '/report/folder.txt']) {
        const res = await fetch(`${origin}${path}`)
        assert.equal(res.status, 404, path)
      }
    })
  })
})

test('unknown /report subpaths are 404, not a directory listing', async () => {
  await withRoot(async (root) => {
    await withServer({ root }, async ({ origin }) => {
      const res = await fetch(`${origin}/report/a/b/c`)
      assert.equal(res.status, 400) // multi-segment name
      const other = await fetch(`${origin}/elsewhere`)
      assert.equal(other.status, 404)
    })
  })
})

test('only GET and HEAD are allowed', async () => {
  await withRoot(async (root) => {
    await withServer({ root }, async ({ origin }) => {
      const res = await fetch(`${origin}/report/`, { method: 'POST' })
      assert.equal(res.status, 405)
      assert.equal(res.headers.get('allow'), 'GET, HEAD')
    })
  })
})

test('HEAD returns headers without a body', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'a.txt'), 'hello')
    await withServer({ root }, async ({ origin }) => {
      const res = await fetch(`${origin}/report/a.txt`, { method: 'HEAD' })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-length'), '5')
      assert.equal(await res.text(), '')
    })
  })
})

test('a non-loopback Host is refused', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'a.txt'), 'x')
    await withServer({ root }, async ({ port }) => {
      // fetch() will not let us forge Host, so drive the socket directly.
      const { statusCode } = await rawRequest(port, { Host: 'evil.example.com' })
      assert.equal(statusCode, 403)
    })
  })
})

test('a cross-site marker is refused', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'a.txt'), 'x')
    await withServer({ root }, async ({ port }) => {
      const { statusCode } = await rawRequest(port, {
        Host: `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'cross-site',
      })
      assert.equal(statusCode, 403)
    })
  })
})

/** GET `/report/` with fully controlled headers. */
function rawRequest(port, headers) {
  return new Promise((resolve, reject) => {
    import('node:http').then(({ request }) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/report/', method: 'GET', headers, setHost: false },
        (res) => {
          res.resume()
          res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers }))
        },
      )
      req.on('error', reject)
      req.end()
    }, reject)
  })
}
