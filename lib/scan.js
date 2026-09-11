// SPDX-License-Identifier: MIT
/**
 * Artifact directory scanning and contract mapping.
 *
 * Split out from `index.js` so it can be exercised against a temp directory
 * with injected `fs` functions and no HTTP layer in the way.
 *
 * The response shape produced here is a hard contract with the
 * `dsh-artifacts` sidebar client (see docs/DESIGN.md §3). Do not add, rename or
 * reorder fields without checking that client:
 *
 *   { count: number, items: [{ name, url, ext, size, mtime }] }
 *
 * `mine` must stay absent — its absence is what hides the client's
 * "This chat / All" toggle.
 */

import { readdir, stat } from 'node:fs/promises'

/** Extensions we are willing to list and serve, lowercase, without the dot. */
export const ALLOWED_EXT = new Set([
  // documents
  'md', 'markdown', 'txt', 'log', 'json', 'csv', 'tsv',
  'html', 'htm', 'xml', 'yaml', 'yml', 'pdf',
  // images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg',
])

export const DEFAULT_MAX_ITEMS = 500

/**
 * Lowercase extension of `name` when it is whitelisted, else `null`.
 *
 * Returns null for dotfiles (`.env`) and for names with no extension: a lone
 * leading dot is not an extension.
 *
 * @param {string} name
 * @returns {string | null}
 */
export function extOf(name) {
  if (typeof name !== 'string') return null
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return null
  const ext = name.slice(dot + 1).toLowerCase()
  return ALLOWED_EXT.has(ext) ? ext : null
}

/**
 * Map one directory entry to a contract item, or `null` when it is not listable.
 *
 * @param {string} name
 * @param {{ size: number, mtimeMs: number }} stats
 * @returns {{ name: string, url: string, ext: string, size: number, mtime: number } | null}
 */
export function toItem(name, stats) {
  const ext = extOf(name)
  if (ext === null) return null
  return {
    name,
    // The client assigns this straight to an iframe `src`, so it must be a
    // self-contained, percent-encoded, root-relative URL.
    url: `${'/report/'}${encodeURIComponent(name)}`,
    ext,
    size: stats.size,
    // Seconds, matching the field the client expects.
    mtime: Math.floor(stats.mtimeMs / 1000),
  }
}

/** Newest first; name ascending as a stable tie-break. */
export function compareNewestFirst(a, b) {
  if (b.mtime !== a.mtime) return b.mtime - a.mtime
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * Scan `root` and build the index payload.
 *
 * Never throws: a missing or unreadable root comes back as an `error` string,
 * which the client renders inline instead of an empty list. `count` and `items`
 * are always present so a strict client cannot crash on the error path.
 *
 * Non-recursive by design; dotfiles, directories, symlinks, and non-whitelisted
 * extensions are skipped rather than reported.
 *
 * @param {string} root
 * @param {{
 *   maxItems?: number,
 *   deps?: {
 *     readdir?: typeof readdir,
 *     stat?: typeof stat,
 *     onWarn?: (message: string) => void,
 *   },
 * }} [options]
 * @returns {Promise<{ count: number, items: object[], error?: string }>}
 */
export async function scan(root, options = {}) {
  const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0
    ? options.maxItems
    : DEFAULT_MAX_ITEMS
  const deps = options.deps ?? {}
  const readdirImpl = deps.readdir ?? readdir
  const statImpl = deps.stat ?? stat
  const warn = deps.onWarn ?? (() => {})

  let entries
  try {
    entries = await readdirImpl(root, { withFileTypes: true })
  } catch (err) {
    return { count: 0, items: [], error: describeRootError(root, err) }
  }

  const items = []
  for (const entry of entries) {
    if (!entry.isFile()) continue          // skips directories and symlinks
    if (entry.name.startsWith('.')) continue
    if (extOf(entry.name) === null) continue

    let stats
    try {
      stats = await statImpl(`${root}/${entry.name}`)
    } catch {
      continue                             // raced away between readdir and stat
    }
    if (!stats.isFile()) continue

    const item = toItem(entry.name, stats)
    if (item) items.push(item)
  }

  items.sort(compareNewestFirst)

  if (items.length > maxItems) {
    warn(`artifact index truncated at maxItems=${maxItems} (${items.length} candidates)`)
    items.length = maxItems
  }

  return { count: items.length, items }
}

/**
 * Human-readable, non-leaking description of why the root could not be read.
 *
 * The absolute path is intentionally included: the operator set it, so echoing
 * it back helps them fix it, and this endpoint is loopback-only.
 *
 * @param {string} root
 * @param {unknown} err
 * @returns {string}
 */
export function describeRootError(root, err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
  if (code === 'ENOENT') return `artifact root does not exist: ${root}`
  if (code === 'EACCES' || code === 'EPERM') return `artifact root is not readable: ${root}`
  if (code === 'ENOTDIR') return `artifact root is not a directory: ${root}`
  const message = err instanceof Error ? err.message : String(err)
  return `cannot read artifact root ${root}: ${message}`
}
