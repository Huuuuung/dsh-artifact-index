// SPDX-License-Identifier: MIT
/**
 * Request trust checks for the local `/report` routes.
 *
 * Pure header inspection — no IO, no services, so the whole matrix is unit
 * testable and the plugin never gains a second "unsatisfied inject" failure
 * mode just to ask the host who it trusts.
 *
 * Why this exists at all: `/report/` serves file bytes to anyone who can reach
 * the port. The port is loopback-bound (`networkExposure: loopback`), but
 * loopback binding alone does NOT stop a web page the user visits from issuing
 * `fetch("http://127.0.0.1:<port>/report/...")` and reading the response — a
 * real, well-known attack against local dev servers. Two independent gates:
 *
 *  1. **Host must be loopback (or explicitly trusted).** This is the
 *     DNS-rebinding gate: an attacker page on `evil.com` whose DNS later
 *     resolves to 127.0.0.1 still sends `Host: evil.com`, and that is rejected.
 *  2. **`Sec-Fetch-Site` / `Origin` must not say "some other origin".** This is
 *     the cross-site-read gate for the normal case where the attacker has no
 *     control over DNS.
 *
 * Mirrors `isTrustedApiRequest` in dsh-better-sidebar so both plugins on this
 * profile behave the same way, minus the `webRuntime.trustedHosts` lookup
 * (replaced by the optional `trustedHosts` config).
 */

/**
 * Extract a hostname from a raw `Host` header value.
 *
 * Deliberately rejects whitespace, backslashes and `@`: a `Host` header is
 * always a bare `host[:port]` authority, so anything else is either malformed
 * or an attempt to make two parsers disagree about which host this is.
 *
 * @param {unknown} authority
 * @returns {string | null} hostname, lowercased, IPv6 still bracketed; null if unusable
 */
export function parseHostname(authority) {
  if (typeof authority !== 'string') return null
  const value = authority.trim()
  if (value.length === 0 || value.length > 255) return null
  if (/[\s\\@\/]/.test(value)) return null
  try {
    // IPv6 authorities are bracketed, and WHATWG URL keeps the brackets in
    // `.hostname` (`[::1]`), which isLoopbackHost accounts for.
    return new URL(`http://${value}`).hostname.toLowerCase() || null
  } catch {
    return null
  }
}

/** Strip `[` `]` from a bracketed IPv6 literal. */
function unbracket(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/**
 * True when `hostname` names this machine over loopback.
 *
 * Covers `localhost`, all of 127.0.0.0/8, `::1`, and IPv4-mapped IPv6
 * (`::ffff:127.0.0.1`).
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLoopbackHost(hostname) {
  if (typeof hostname !== 'string') return false
  const bare = unbracket(hostname.toLowerCase())
  if (bare === 'localhost' || bare === '::1') return true
  if (bare.startsWith('::ffff:')) {
    const mapped = bare.slice('::ffff:'.length)
    // `::ffff:7f00:1` is the hexadecimal form of 127.0.0.1.
    if (/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(mapped)) {
      const high = Number.parseInt(mapped.split(':')[0], 16)
      return (high >> 8) === 0x7f
    }
    return isLoopbackHost(mapped)
  }
  const parts = bare.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN))
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  return octets[0] === 127
}

/**
 * True when `hostname` appears in the operator-supplied allowlist.
 *
 * Entries may be bare hostnames or `host:port`; ports in the list are ignored
 * because this compares hostnames only (matching dsh-better-sidebar).
 *
 * @param {string} hostname
 * @param {unknown} trustedHosts
 * @returns {boolean}
 */
export function isTrustedHostname(hostname, trustedHosts) {
  if (!Array.isArray(trustedHosts)) return false
  const needle = unbracket(String(hostname).toLowerCase())
  return trustedHosts.some((entry) => {
    const value = normalizeTrustEntry(entry)
    return value !== null && value === needle
  })
}

/**
 * Reduce one `trustedHosts` entry to a bare hostname.
 *
 * The port strip is deliberately narrow: `::1` must survive it. Splitting on
 * the last colon would turn that into `:` and silently disable the whole entry,
 * so bracketed IPv6 and bare multi-colon literals are recognised explicitly and
 * only a single colon followed by digits is treated as a port.
 *
 * @param {unknown} entry
 * @returns {string | null}
 */
function normalizeTrustEntry(entry) {
  if (typeof entry !== 'string') return null
  const value = entry.trim().toLowerCase()
  if (value.length === 0) return null

  if (value.startsWith('[')) {
    // `[::1]` or `[::1]:9200` — the port lives outside the brackets.
    const end = value.indexOf(']')
    return end > 1 ? value.slice(1, end) : null
  }

  const colons = value.split(':').length - 1
  if (colons > 1) return value // bare IPv6 literal; nothing to strip
  if (colons === 1) return value.replace(/:\d+$/, '') || null
  return value
}

/**
 * Decide whether one request may reach the `/report` routes.
 *
 * @param {{ headers?: Record<string, unknown>, method?: string }} req
 * @param {{ trustedHosts?: string[] }} [options]
 * @returns {boolean}
 */
export function isTrustedRequest(req, options = {}) {
  const headers = req?.headers ?? {}

  const hostname = parseHostname(headers.host)
  if (hostname === null) return false
  if (!isLoopbackHost(hostname) && !isTrustedHostname(hostname, options.trustedHosts)) return false

  const site = headers['sec-fetch-site']
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return false

  const origin = headers.origin
  if (typeof origin !== 'string' || origin.length === 0) {
    // No Origin header: a top-level navigation or a non-browser client (curl).
    // Both are allowed — the Host gate already ran.
    return true
  }
  try {
    return new URL(origin).hostname.toLowerCase() === unbracket(hostname)
  } catch {
    return false
  }
}
