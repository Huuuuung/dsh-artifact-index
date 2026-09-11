// SPDX-License-Identifier: MIT
/**
 * dsh-artifact-index — host half.
 *
 * Mounts two things on the DSH web server, both under `/report`:
 *
 *   GET /report/            (and `/report`)  → the JSON index contract
 *   GET /report/<name>                        → the artifact's bytes
 *
 * The `dsh-artifacts` sidebar tab polls the first and puts the `url` of each
 * item into an iframe, which is the second.
 *
 * Design decisions worth knowing before editing:
 *
 *  - ONE `prefix` route with internal dispatch, not an `exact` + a `prefix`
 *    route on the same path. Overlapping registrations are the one place where
 *    a host-version bump could silently change which handler wins, and a
 *    duplicate prefix mount fails the *entire plugin tree* at boot, so a single
 *    unambiguous registration is worth the extra branch inside the handler.
 *  - Read-only. This plugin never writes, never deletes, never recurses.
 *  - Only `webServer` is injected. Every extra service in `inject` is another
 *    way to become a plugin that is mounted but silently never activates
 *    (Cordis does not report unsatisfied injections at all), so the trust
 *    checks that other plugins delegate to `webRuntime` are implemented
 *    locally in ./trust.js instead.
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

import { decodeSegment, resolveArtifact } from './safe-path.js'
import { DEFAULT_MAX_ITEMS, extOf, scan } from './scan.js'
import { isTrustedRequest } from './trust.js'

export const name = 'dsh-artifact-index'

/**
 * `webServer` is the host's HTTP seam. Without it there is nothing to mount on
 * — and note that an unsatisfied `inject` makes Cordis skip the plugin
 * *silently*, with no error and no log line, so a missing route here usually
 * means this array is wrong rather than that the handler is broken.
 */
export const inject = ['webServer']

const ROUTE_PREFIX = '/report'
const INDEX_PATHS = new Set([ROUTE_PREFIX, `${ROUTE_PREFIX}/`])

const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024

/**
 * `config.csp` holds a mode NAME; the map below holds what actually goes on the
 * wire. Keeping them apart matters — `sandbox-scripts` is what a user writes in
 * the config, `sandbox allow-scripts` is what CSP expects in the header, and
 * conflating the two silently downgrades every HTML artifact to the strict
 * policy.
 */
const CSP_MODE_SANDBOX = 'sandbox'
const CSP_MODE_SANDBOX_SCRIPTS = 'sandbox-scripts'
const CSP_MODE_NONE = 'none'
const CSP_MODES = new Set([CSP_MODE_SANDBOX, CSP_MODE_SANDBOX_SCRIPTS, CSP_MODE_NONE])
const CSP_HEADER = {
  [CSP_MODE_SANDBOX]: 'sandbox',
  [CSP_MODE_SANDBOX_SCRIPTS]: 'sandbox allow-scripts',
}

/** Types we are willing to hand back; everything servable has an entry. */
const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  svg: 'image/svg+xml',
  xml: 'application/xml; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8',
  yml: 'application/yaml; charset=utf-8',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
}

/** Types a browser renders as a document, so they get the CSP header. */
const DOCUMENT_EXT = new Set(['html', 'htm', 'svg', 'xml'])

/**
 * Cordis entry point — called once with a context scoped to this plugin.
 *
 * `ctx.effect(cb)` runs `cb` now and disposes whatever it returns when the
 * plugin unloads, which is what keeps `/report` from surviving a hot reload
 * and colliding with the next mount.
 *
 * @param {any} ctx
 * @param {{
 *   root?: string,
 *   maxItems?: number,
 *   maxFileBytes?: number,
 *   csp?: string,
 *   trustedHosts?: string[],
 * }} [config]
 */
export function apply(ctx, config = {}) {
  const cfg = { ...(ctx?.config ?? {}), ...(config ?? {}) }
  const logger = ctx?.logger

  const log = (level, message) => {
    const line = `[dsh-artifact-index] ${message}`
    const fn = logger?.[level]
    if (typeof fn === 'function') {
      fn.call(logger, line)
      return
    }
    // Cordis loggers are not guaranteed to expose every level. Without this
    // fallback a diagnostic line silently becomes a no-op — which is exactly
    // how a plugin ends up "not working" with no evidence to look at.
    if (level === 'warn') console.warn(line)
    else if (level === 'error') console.error(line)
    else console.log(line)
  }

  const root = resolveRoot(cfg)
  const maxItems = Number.isInteger(cfg.maxItems) && cfg.maxItems > 0 ? cfg.maxItems : DEFAULT_MAX_ITEMS
  const maxFileBytes = Number.isInteger(cfg.maxFileBytes) && cfg.maxFileBytes > 0
    ? cfg.maxFileBytes
    : DEFAULT_MAX_FILE_BYTES
  const csp = CSP_MODES.has(cfg.csp) ? cfg.csp : CSP_MODE_SANDBOX
  const trustedHosts = Array.isArray(cfg.trustedHosts)
    ? cfg.trustedHosts.filter((h) => typeof h === 'string')
    : []

  log('info', `artifact root = ${root} (maxItems=${maxItems}, maxFileBytes=${maxFileBytes}, csp=${csp})`)
  if (trustedHosts.length > 0) {
    log('info', `additional trusted hosts: ${trustedHosts.join(', ')}`)
  }

  // Startup self-check. Never fatal: the directory may be created later, and a
  // plugin that refuses to load would take the whole profile's web routes with
  // it. This line exists so that "the list is empty" is diagnosable from logs.
  void stat(root).then(
    (stats) => {
      if (stats.isDirectory()) log('info', 'artifact root is readable')
      else log('warn', `artifact root is not a directory: ${root}`)
    },
    (err) => log('warn', `artifact root is not readable yet (${err?.code ?? err}): ${root}`),
  )

  const handler = createHandler({ root, maxItems, maxFileBytes, csp, trustedHosts, log })

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    'dsh-artifact-index: /report index + file routes',
  )
}

/**
 * Resolve the artifact root.
 *
 * Precedence: explicit plugin config, then `DSH_ARTIFACT_INDEX_ROOT`, then
 * `$DSH_HOME/artifacts`. `~` is expanded and the result fully resolved so that
 * the startup log and the traversal checks always agree on one absolute path.
 *
 * @param {{ root?: string }} cfg
 * @returns {string}
 */
export function resolveRoot(cfg) {
  const configured = typeof cfg?.root === 'string' ? cfg.root.trim() : ''
  const fromEnv = typeof process.env.DSH_ARTIFACT_INDEX_ROOT === 'string'
    ? process.env.DSH_ARTIFACT_INDEX_ROOT.trim()
    : ''
  const chosen = configured || fromEnv
  if (chosen) return resolve(expandHome(chosen))
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return resolve(join(dshHome, 'artifacts'))
}

/** Expand a leading `~` or `~/` to the user's home directory. */
function expandHome(p) {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/**
 * Build the request handler.
 *
 * @param {{
 *   root: string,
 *   maxItems: number,
 *   maxFileBytes: number,
 *   csp: string,
 *   trustedHosts: string[],
 *   log: (level: string, message: string) => void,
 * }} options
 *
 * Exported for the contract tests, which drive it behind a real HTTP server so
 * the exact status/header/body shape can be asserted without going through the
 * sidebar UI. Not part of the plugin's public surface.
 */
export function createHandler(options) {
  const { root, maxItems, maxFileBytes, csp, trustedHosts, log } = options

  return async function handleRequest(req, res) {
    try {
      if (!isTrustedRequest(req, { trustedHosts })) {
        return sendJson(res, 403, { error: 'forbidden: untrusted request origin' })
      }

      const method = req.method ?? 'GET'
      if (method !== 'GET' && method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD')
        return sendJson(res, 405, { error: `method not allowed: ${method}` })
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const pathname = url.pathname

      if (INDEX_PATHS.has(pathname)) {
        // `?session=<id>` is part of the client's contract but has no meaning in
        // v0.1 (no per-session attribution yet); it is parsed and ignored.
        const payload = await scan(root, { maxItems, deps: { onWarn: (m) => log('warn', m) } })
        if (payload.error) log('warn', `index request failed: ${payload.error}`)
        return sendJson(res, 200, payload, method === 'HEAD')
      }

      if (pathname.startsWith(`${ROUTE_PREFIX}/`)) {
        return await sendArtifact(req, res, pathname.slice(ROUTE_PREFIX.length + 1), method)
      }

      return sendJson(res, 404, { error: 'not found' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('warn', `unhandled error for ${req?.url}: ${message}`)
      if (!res.headersSent) return sendJson(res, 500, { error: 'internal error' })
      res.end()
    }
  }

  /**
   * `GET /report/<name>` — one file, one segment, no traversal, no recursion.
   */
  async function sendArtifact(req, res, rawSegment, method) {
    // Reject a slash in the *encoded* segment first: `%2F` and `..%2F` survive
    // URL normalisation, and catching them before decoding keeps the second
    // check below from being the only thing standing between a request and the
    // filesystem.
    if (rawSegment.includes('/') || rawSegment.length === 0) {
      return sendJson(res, 400, { error: 'bad request: malformed artifact name' })
    }

    const name = decodeSegment(rawSegment)
    if (name === null || name.includes('/')) {
      return sendJson(res, 400, { error: 'bad request: malformed artifact name' })
    }

    const realPath = await resolveArtifact(root, name)
    if (realPath === null) {
      // One message for "outside the root", "does not exist", "hidden" and
      // "not a file": distinguishing them would turn this route into an
      // existence oracle for anything on disk.
      return sendJson(res, 404, { error: 'artifact not found' })
    }

    const ext = extOf(name)
    if (ext === null) {
      return sendJson(res, 404, { error: 'artifact type not served' })
    }

    let stats
    try {
      stats = await stat(realPath)
    } catch {
      return sendJson(res, 404, { error: 'artifact not found' })
    }
    if (!stats.isFile()) return sendJson(res, 404, { error: 'artifact not found' })

    if (stats.size > maxFileBytes) {
      return sendJson(res, 413, {
        error: `artifact too large: ${stats.size} bytes exceeds maxFileBytes=${maxFileBytes}`,
      })
    }

    const headers = {
      'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': String(stats.size),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Last-Modified': new Date(stats.mtimeMs).toUTCString(),
    }
    if (DOCUMENT_EXT.has(ext) && csp !== CSP_MODE_NONE) {
      // `sandbox` (default) neuters scripts, forms, popups and same-origin
      // access inside an artifact rendered in the viewer's iframe. Agents write
      // HTML artifacts, and artifact content is not a trusted executable
      // surface. See docs/SECURITY.md §2.
      headers['Content-Security-Policy'] = CSP_HEADER[csp]
    }

    if (method === 'HEAD') {
      res.writeHead(200, headers)
      return res.end()
    }

    res.writeHead(200, headers)
    try {
      await pipeline(createReadStream(realPath), res)
    } catch (err) {
      // The client hung up mid-transfer, which is normal for an iframe the user
      // navigated away from. Nothing to do but note it and move on.
      log('warn', `stream aborted for ${name}: ${err?.code ?? err}`)
      res.destroy()
    }
  }
}

/**
 * Send a JSON body. Always `no-store`: the index changes as soon as an agent
 * writes a new artifact, and a cached list is worse than a slow one.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {boolean} [headOnly]
 */
function sendJson(res, status, body, headOnly = false) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(headOnly ? undefined : payload)
}
