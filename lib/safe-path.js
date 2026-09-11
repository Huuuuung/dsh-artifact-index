// SPDX-License-Identifier: MIT
/**
 * Path safety helpers.
 *
 * Every function here is either pure or takes its IO through an injected
 * dependency object, so the traversal matrix can be unit-tested without
 * touching a real filesystem.
 *
 * The threat: `items[].url` is built by *this* plugin, but the artifact name in
 * that URL comes from whatever file happens to sit in the artifact directory,
 * and the HTTP client can request any path under `/report/`. Neither is trusted.
 */

import { resolve, sep } from 'node:path'
import { realpath } from 'node:fs/promises'

/**
 * True when `target` resolves to `root` itself or to something inside it.
 *
 * Pure string logic on already-resolved paths. `resolve()` collapses `..`
 * segments and normalises separators first, so `root/../../etc` cannot slip
 * through as a prefix match.
 *
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
export function isInsideRoot(root, target) {
  const base = resolve(root)
  const candidate = resolve(target)
  if (candidate === base) return true
  return candidate.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * True when `name` is usable as a single path segment for an artifact.
 *
 * Deliberately stricter than the filesystem: one segment only, no separators,
 * no traversal tokens, no NUL, no leading dot (hides `.env`, `.git`, dotfiles),
 * bounded length.
 *
 * Call this on the **percent-decoded** segment.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isSafeName(name) {
  if (typeof name !== 'string') return false
  if (name.length === 0 || name.length > 255) return false
  if (name.includes('/') || name.includes('\\')) return false
  if (name.includes('\0')) return false
  if (name === '.' || name === '..') return false
  if (name.startsWith('.')) return false
  return true
}

/**
 * Resolve one artifact name to a real file inside `root`, or `null`.
 *
 * Two gates, because the first one alone is not enough:
 *  1. lexical — the joined path must stay inside `root`;
 *  2. physical — `realpath` on both ends, so a symlink pointing outside `root`
 *     is rejected even though its lexical path looked fine.
 *
 * @param {string} root
 * @param {string} name percent-decoded single segment
 * @param {{ realpath?: (p: string) => Promise<string> }} [deps]
 * @returns {Promise<string | null>}
 */
export async function resolveArtifact(root, name, deps = {}) {
  const realpathImpl = deps.realpath ?? realpath
  if (!isSafeName(name)) return null

  const candidate = resolve(root, name)
  if (!isInsideRoot(root, candidate)) return null

  let realRoot
  let realCandidate
  try {
    realRoot = await realpathImpl(resolve(root))
    realCandidate = await realpathImpl(candidate)
  } catch {
    // Missing root, missing file, dangling symlink, permission error: all "no".
    return null
  }
  if (!isInsideRoot(realRoot, realCandidate)) return null
  return realCandidate
}

/**
 * Percent-decode a URL path segment without letting a malformed escape throw.
 *
 * @param {string} segment
 * @returns {string | null} decoded text, or null when the escape is invalid
 */
export function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}
