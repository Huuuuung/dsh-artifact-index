# dsh-artifact-index

Artifact index endpoint for the **`dsh-artifacts`** sidebar tab in DeepSeek Harness (DSH).

Zero dependencies, read-only, ~600 lines including comments and tests.
No telemetry, no outbound network calls, no install scripts.

---

## The problem it solves

`dsh-artifacts` is a **viewer-only** client. Its host half (`lib/index.js`) is a
deliberate no-op, and the browser half polls an external endpoint:

```js
// dsh-artifacts/lib/client.js:32
var DEFAULT_LIST_URL = "/report/?list=1";
```

So after installing it, the sidebar reliably shows:

> Could not read the artifact index. HTTP 404 from /report/?list=1&session=…

**That is not a bug — it is half a feature.** Upstream left "where does the index
come from" to the user. This plugin is that half: it mounts `/report` on the DSH
web server, answers with the JSON shape upstream expects, and serves the artifact
bytes for the viewer's iframe.

---

## Install

Requires **DSH ≥ 0.1.5-rc.1**, with `dsh-better-sidebar` and `dsh-artifacts`
installed first — this plugin only adds the backend, it does not replace them.

From npm:

```bash
dsh plugin --profile desktop add dsh-artifact-index
```

From source (repository root):

```bash
# Symlink: edit code, restart DSH Desktop, done
dsh plugin --profile desktop add "link:<absolute path to this repo>"

# Or freeze a copy
dsh plugin --profile desktop add "file:<absolute path to this repo>"
```

Restart DSH Desktop, then confirm the mount row exists:

```bash
dsh --profile desktop --dump-config | grep artifact-index
```

**Changing a plugin requires a new session** — DSH snapshots the plugin and tool
list at session creation.

### Verifying the install

The plugin writes one line to the DSH Desktop log at startup (Windows:
`%APPDATA%\DSH Desktop\logs\dsh-<date>.log`):

```
[dsh-artifact-index] artifact root = <artifact root> (maxItems=500, ...)
```

- **Present** → the plugin activated; what remains is the Artifacts tab in the sidebar.
- **Absent** → the plugin did not activate. Check `dsh.profile.bundles` for
  `dsh-artifact-index`, and grep the log for `failed to apply loader entry …`.

Note that the DSH web server rejects requests that do not come from a browser, so
`curl` and similar tools cannot be used to verify the route. For an end-to-end
check against a real directory, use the script in this repository:

```bash
node scripts/smoke.mjs <artifact root>
```

It drives the handler directly and fetches every listed artifact back. (The script
binds to loopback and only requests its own port.)

---

## Configuration

Set it under `config` on the mount row in the profile's `cordis.patch.yml`, or
via environment variables. Precedence: **config > env > default**.

```yaml
- id: dsh-artifact-index
  name: 'dsh-artifact-index'
  config:
    root: <artifact directory>
    maxItems: 500
    maxFileBytes: 26214400
    csp: sandbox
```

| Key | Default | Meaning |
|---|---|---|
| `root` | `$DSH_HOME/artifacts` | Directory to index. **Not recursive** — this level only. |
| `maxItems` | `500` | Cap on returned entries; extras are dropped and logged. |
| `maxFileBytes` | `26214400` (25 MB) | Per-file cap; larger files get `413`. |
| `csp` | `sandbox` | `Content-Security-Policy` for HTML/SVG/XML. See below. |
| `trustedHosts` | `[]` | Extra allowed Hosts. Only needed if DSH is not on loopback. |

`$DSH_HOME` is the DSH data directory (on Windows, `echo $env:DSH_HOME`, or read
it out of `dsh --profile desktop --dump-config`).

Environment variable: `DSH_ARTIFACT_INDEX_ROOT` overrides `root` when no config
value is given.

`csp` takes three values:

| Value | Header actually sent | Use when |
|---|---|---|
| `sandbox` (default) | `sandbox` | Scripts, forms, popups and same-origin access inside the artifact are dead. |
| `sandbox-scripts` | `sandbox allow-scripts` | You need an HTML artifact that renders with JS (e.g. a self-drawn chart). |
| `none` | none | Only if you understand the risk. |

---

## Endpoint contract

### `GET /report/` (also `/report`, and `?list=1&session=<id>`)

```json
{
  "count": 2,
  "items": [
    { "name": "report.html", "url": "/report/report.html", "ext": "html", "size": 5120, "mtime": 1757000000 },
    { "name": "data.json",   "url": "/report/data.json",   "ext": "json", "size": 2048, "mtime": 1756990000 }
  ]
}
```

- `items` is newest-first by `mtime`; ties break by `name` ascending.
- `url` is used **verbatim** as the iframe `src`, so it is root-relative and
  percent-encoded.
- `mtime` is in **seconds**.
- **`mine` is deliberately absent** — upstream hides its "This chat / All"
  toggle when the key is missing, and v0.1 cannot answer attribution correctly.
  See "About `mine`" below.
- An unreadable root does not throw: the response is `200` with
  `{ count: 0, items: [], error: "…" }` so the client can show it inline.

### `GET /report/<name>`

Returns the artifact's bytes. `Content-Type` comes from the extension allowlist;
HTML/SVG/XML also carry the CSP header. **Single-segment names only** — no
sub-paths.

---

## About `mine`

`mine` is an **optional field in the `dsh-artifacts` client contract**, not
something this plugin invented.

Its meaning is "**was this artifact produced by the current session?**" The
client renders a **This chat / All** switcher from it, so a user can filter a
pile of historical output down to the current run.

- Key **present** → the client shows the switcher.
- Key **absent** → the client hides it entirely.

v0.1 omits `mine` on purpose, because a wrong answer is worse than no answer.
Doing it properly means **reconstructing** this session's artifact paths from the
session record, which has no ready-made "output list". The workable approach is
to parse **tool-call arguments** (e.g. the `path` argument of a file-writing
tool) — not to regex the raw transcript, which misfires the moment a
conversation merely *mentions* a filename.

So v0.1 returns an honest, flat list of *all* artifacts rather than a fabricated
attribution. The `?session=<id>` parameter is parsed and ignored, reserved for
v0.2.

---

## Security

This is a **local file-read** surface, so it treats all input as untrusted. Full
threat model in [`SECURITY.md`](SECURITY.md).

**What it does:**

- Dual path checking: containment against the resolved prefix, **plus** a
  `realpath` check on both ends — so a symlink pointing outside the root is
  refused (a string check alone cannot catch that).
- **Single-segment** names only; `%2F`, `..%2F`, `..\\` and friends are rejected
  both before and after percent-decoding.
- Extension allowlist (documents + images); anything else is `404`.
- **No recursion**, hidden files (leading `.`) and symlinks are skipped.
- Only `GET`/`HEAD`; everything else is `405`.
- Cross-site gate: `Host` must be loopback (or in `trustedHosts`), and
  `Sec-Fetch-Site: cross-site` is refused — this blocks page-initiated reads of
  the local port.
- One more `stat` before serving, re-checking the size cap, so a swapped file
  cannot slip past the earlier check.

**What it explicitly does not do:**

- **No authentication.** Anyone who can reach the port can read every allowed
  file under `root`. The boundary is the profile's `networkExposure: loopback` —
  **do not** expose DSH to the internet with this installed.
- **No writes, no deletes, no upload or publish path.**
- **No per-session attribution** (`mine`).
- **No symlink following**, even to targets inside the root.

---

## Development

```bash
node --test          # 64 tests: contract, traversal, trust, assembly
```

The two core suites:

- `test/contract.test.mjs` — a **real HTTP server** against a **real temp
  directory**, asserting the upstream contract literally (field set, ordering,
  absent `mine`, CSP, `413`, `403`). A contract mismatch surfaces as a single
  error line in the UI, which makes it easy to miss without tests.
- `test/safe-path.test.mjs` — the traversal matrix, including the two cases a
  string check cannot catch: a sibling directory sharing the root's prefix, and
  a symlink pointing outside the root.

Layout:

```
lib/index.js      Cordis host half: routes, trust gate, CSP, streaming
lib/scan.js       Directory scan + contract mapping (injectable fs, unit-testable)
lib/safe-path.js  Path safety (dual checks)
lib/trust.js      Request trust checks (Host / Sec-Fetch-Site / Origin)
```

### Dependencies and network behaviour

There are **no third-party runtime dependencies**, and no install-time scripts:
`package.json` has no `preinstall` / `install` / `postinstall`, so installing this
package executes no code.

Two places are all that is needed to review its network behaviour:

1. The `import` statements in `lib/*.js` — all `node:` built-ins.
2. `scripts/smoke.mjs` — binds loopback, requests only its own port, sends nothing
   anywhere else.

---

## Roadmap

**v0.2 — per-session attribution (`mine`)**

Reconstruct this session's artifact paths from the session event stream. This
must parse **tool-call arguments** (the `path` of a write tool) rather than
regex-scanning the raw transcript — otherwise merely mentioning a filename
causes a false positive. Surfaces as `mine: true/false`, and the sidebar gains
its `This chat / All` switch.

**v0.2 — pagination and search**

`maxItems` is a hard truncation today. Past a few hundred artifacts it needs
`?offset=` or name filtering.

**v0.3 — thumbnails**

Images are served full-size. Lots of screenshots will make the sidebar slow.

---

## Design notes

[`docs/DESIGN.md`](docs/DESIGN.md) (Chinese) records the design reasoning and
trade-offs: why one `prefix` route instead of an `exact` + `prefix` pair, why
`ctx.webRuntime` is not injected, and the risk register.

---

## License

MIT
