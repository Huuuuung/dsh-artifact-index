# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-11

First release. Provides the missing backend for the `dsh-artifacts` sidebar tab.

### Added

- `GET /report/` — the JSON index contract the `dsh-artifacts` client polls
  (`/report/?list=1`, optional `&session=<id>` parsed and ignored). Items are
  sorted newest-first and carry `name`, `url`, `ext`, `size`, `mtime`. The
  `mine` key is deliberately absent so the client hides its
  "This chat / All" toggle, which cannot be answered correctly yet.
- `GET /report/<name>` — serves one artifact's bytes with a
  `Content-Type` derived from an extension allowlist.
- `Content-Security-Policy: sandbox` on HTML/SVG/XML responses, with
  `sandbox-scripts` and `none` escape hatches behind config.
- Per-file size cap (`413`) and index cap (`maxItems`).
- Config: `root`, `maxItems`, `maxFileBytes`, `csp`, `trustedHosts`; plus the
  `DSH_ARTIFACT_INDEX_ROOT` environment variable.

### Security

- Dual path-traversal defence: resolve-prefix containment **plus** a realpath
  check on both ends, catching symlinks that point outside the root.
- Cross-site read defence: `Host` must be loopback or allowlisted (DNS-rebinding
  gate), and `Sec-Fetch-Site: cross-site` / mismatched `Origin` are refused.
- Non-recursive scan; hidden files, directories and symlinks are skipped.
- Read-only by construction: no write, delete, rename or upload path exists.

### Known limitations

- No per-session attribution (`mine`), no pagination, no thumbnails.
- No authentication; the sole boundary is the DSH profile's loopback binding.
- Symlinks are never followed, even to targets inside the root.

[0.1.0]: https://github.com/Huuuuung/dsh-artifact-index/releases/tag/v0.1.0
