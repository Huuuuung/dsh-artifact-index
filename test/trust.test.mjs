// SPDX-License-Identifier: MIT
import test from 'node:test'
import assert from 'node:assert/strict'

import { isLoopbackHost, isTrustedHostname, isTrustedRequest, parseHostname } from '../lib/trust.js'

test('parseHostname extracts hostnames from bare authorities', () => {
  assert.equal(parseHostname('127.0.0.1:9200'), '127.0.0.1')
  assert.equal(parseHostname('127.0.0.1'), '127.0.0.1')
  assert.equal(parseHostname('localhost:8080'), 'localhost')
  assert.equal(parseHostname('LOCALHOST'), 'localhost')
  assert.equal(parseHostname('[::1]:9200'), '[::1]')
  assert.equal(parseHostname('evil.example.com'), 'evil.example.com')
})

test('parseHostname rejects values that are not a bare authority', () => {
  const bad = [
    '', '   ', 'a b', 'evil.com\\@127.0.0.1', 'user@host', 'host/path',
    'x'.repeat(256), null, undefined, 42, {},
  ]
  for (const value of bad) {
    assert.equal(parseHostname(value), null, String(value))
  }
})

test('parseHostname rejects an out-of-range port rather than guessing', () => {
  assert.equal(parseHostname('127.0.0.1:99999'), null)
})

test('isLoopbackHost accepts every spelling of loopback', () => {
  for (const host of [
    '127.0.0.1', '127.0.0.2', '127.255.255.254', '127.1.2.3',
    'localhost', '::1', '[::1]',
    '::ffff:127.0.0.1', '::ffff:7f00:1',
  ]) {
    assert.equal(isLoopbackHost(host), true, host)
  }
})

test('isLoopbackHost rejects everything else', () => {
  for (const host of [
    '0.0.0.0', '10.0.0.1', '192.168.1.10', '128.0.0.1', '126.0.0.1',
    '127.0.0.256', '127.0.0', '1.27.0.1', 'example.com', 'localhost.evil.com',
    '::2', 'fe80::1', '::ffff:7e00:1', '', null, 42,
  ]) {
    assert.equal(isLoopbackHost(host), false, String(host))
  }
})

test('isTrustedHostname matches bare and host:port entries, ignoring brackets', () => {
  assert.equal(isTrustedHostname('nas.local', ['nas.local']), true)
  assert.equal(isTrustedHostname('nas.local', ['nas.local:9200']), true)
  assert.equal(isTrustedHostname('[::1]', ['::1']), true)
  assert.equal(isTrustedHostname('nas.local', ['NAS.LOCAL']), true)
  assert.equal(isTrustedHostname('nas.local', []), false)
  assert.equal(isTrustedHostname('nas.local', null), false)
  assert.equal(isTrustedHostname('nas.local', ['other.local', 7]), false)
})

test('isTrustedRequest allows a loopback browser request with no Origin', () => {
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:9200' } }), true)
})

test('isTrustedRequest allows a matching same-origin request', () => {
  assert.equal(
    isTrustedRequest({
      headers: { host: '127.0.0.1:9200', origin: 'http://127.0.0.1:9200' },
    }),
    true,
  )
})

test('isTrustedRequest rejects a non-loopback Host (DNS rebinding)', () => {
  // The rebound page reaches 127.0.0.1 but still declares its own domain.
  assert.equal(
    isTrustedRequest({ headers: { host: 'evil.example.com' } }),
    false,
  )
  assert.equal(
    isTrustedRequest({ headers: { host: 'evil.example.com', origin: 'http://evil.example.com' } }),
    false,
  )
})

test('isTrustedRequest rejects an explicit cross-site marker', () => {
  assert.equal(
    isTrustedRequest({ headers: { host: '127.0.0.1:9200', 'sec-fetch-site': 'cross-site' } }),
    false,
  )
  assert.equal(
    isTrustedRequest({
      headers: { host: '127.0.0.1:9200', 'sec-fetch-site': 'CROSS-SITE' },
    }),
    false,
  )
})

test('isTrustedRequest rejects a mismatched Origin', () => {
  assert.equal(
    isTrustedRequest({
      headers: { host: '127.0.0.1:9200', origin: 'http://evil.example.com' },
    }),
    false,
  )
  assert.equal(
    isTrustedRequest({ headers: { host: '127.0.0.1:9200', origin: 'not a url' } }),
    false,
  )
})

test('isTrustedRequest requires a Host header at all', () => {
  assert.equal(isTrustedRequest({ headers: {} }), false)
  assert.equal(isTrustedRequest({}), false)
})

test('isTrustedRequest honours the trustedHosts allowlist', () => {
  const req = { headers: { host: 'nas.local:9200', origin: 'http://nas.local:9200' } }
  assert.equal(isTrustedRequest(req), false)
  assert.equal(isTrustedRequest(req, { trustedHosts: ['nas.local'] }), true)
})
