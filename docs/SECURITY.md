# Security model

`dsh-artifact-index` is a **local file read** endpoint. This document states what
it defends against, what it explicitly does not, and why each choice was made.

Scope of this document: the plugin's own code. It does not cover the DSH web
server, the `dsh-artifacts` client, or the browser.

---

## 1. Threat model

### What we assume

- The HTTP port is reachable by anything running on the machine, and by any web
  page the user visits (browsers may issue requests to `127.0.0.1`).
- The artifact directory contains files written by an **agent**, i.e. content
  derived from model output, tool output, and the open web. File names are
  attacker-influenced in the worst case.
- Request paths, query strings and headers are fully attacker-controlled.

### What we do not assume

- That the port is exposed to the network. The DSH profile sets
  `networkExposure: loopback`; this plugin relies on it and does not add
  authentication.
- That the artifact directory is trusted. It is read, never executed.

### Assets being protected

1. **Files outside the artifact root.** The primary asset: `.credentials.yaml`,
   session logs, SSH keys, the rest of the user's disk.
2. **The user's browser context.** Artifact HTML is rendered in an iframe inside
   the DSH web GUI; it must not be able to script, navigate, or exfiltrate from
   that origin.
3. **Confidentiality *within* the root** is *not* an asset: anything with a
   whitelisted extension in the root is considered servable.

---

## 2. Threats and mitigations

### 2.1 Path traversal (`../../.credentials.yaml`)

**Two independent gates, because either one alone is insufficient.**

1. *Lexical.* `isInsideRoot(root, resolve(root, name))` compares against
   `root + path.sep`, not a bare `startsWith(root)`. Without the separator,
   `/srv/artifacts-evil` passes a naive `startsWith('/srv/artifacts')` check.
2. *Physical.* `realpath()` is applied to **both** the root and the candidate,
   and the containment check is re-run on the results. A symlink
   `root/innocent.html → /etc/passwd` is lexically inside the root, so only this
   gate catches it.

The name must additionally be a **single path segment**: no `/`, no `\`, no
`..`, no `.`, no NUL, no leading dot, ≤255 chars.

Percent-decoding happens **after** the encoded segment is checked for `/`, so
`..%2F` and `%2Fetc%2Fpasswd` are rejected twice, at two different layers.
`test/safe-path.test.mjs` and `test/contract.test.mjs` cover the matrix.

Failure of any gate returns `404` with one generic message. Telling "outside the
root" apart from "does not exist" would turn the route into an existence oracle
for the entire filesystem.

### 2.2 Cross-site reads (a web page reading local files)

Loopback binding does **not** stop a page at `https://evil.example.com` from
issuing `fetch("http://127.0.0.1:9200/report/?list=1")`. Two gates:

- **Host gate.** `Host` must be `localhost`, `127.0.0.0/8`, `::1`, an
  IPv4-mapped equivalent, or an entry in `trustedHosts`. This is the
  DNS-rebinding gate: a page on a domain that later resolves to `127.0.0.1`
  still sends `Host: evil.example.com`, and is refused. The raw authority is
  rejected outright if it contains whitespace, `/`, `\` or `@`, so two parsers
  cannot disagree about which host a request names.
- **Same-site gate.** `Sec-Fetch-Site: cross-site` → `403`; a present `Origin`
  whose hostname differs from `Host` → `403`.

Absent headers are **allowed** on purpose: a top-level navigation and `curl`
send neither, and both are legitimate ways to reach this route from the machine
itself. See `lib/trust.js`; the logic mirrors `isTrustedApiRequest` in
dsh-better-sidebar so both plugins on this profile behave identically.

### 2.3 Script execution in rendered artifacts

Artifact content is agent output — not a trusted executable surface. Default
`Content-Security-Policy: sandbox` on `html`/`htm`/`svg`/`xml` responses
disables scripts, forms, popups, top-level navigation and same-origin access
inside the viewer's iframe.

`sandbox allow-scripts` (config value `sandbox-scripts`) is the escape hatch for
artifacts that genuinely need JS to render, such as self-drawn charts. It still
withholds `allow-same-origin`, so the frame stays in an opaque origin and cannot
reach DSH's own storage or API. `csp: none` exists for debugging and is
documented as such.

`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` are set on
every response; the latter is set even when CSP is disabled.

### 2.4 Content-type confusion

`Content-Type` is derived from the extension allowlist, never from file content
and never from a client-supplied value. Anything not on the list is rejected
before the file is opened. `nosniff` stops the browser from second-guessing the
declared type.

### 2.5 Resource exhaustion

- `maxItems` (default 500) caps the index payload; truncation is logged.
- `maxFileBytes` (default 25 MB) caps any single transfer with `413`.
- The scan is non-recursive and reads one directory, so cost is bounded by the
  root's own entry count.

There is no rate limiting: this is a loopback, single-user service, and a `403`
storm from a hostile page is already blocked at the Host gate.

### 2.6 Time-of-check / time-of-use

The file is `stat`ed for the size limit and then streamed. A file swapped in
between could be larger than the check saw, or be a symlink that did not exist
at `realpath` time. Mitigation is partial and deliberate: the stream is opened
on the **already-resolved real path** (not on a re-resolved name), so a swap
cannot redirect the read outside the root — only oversize the body. A local
attacker who can race the filesystem already has write access to the artifact
root and needs no attack.

---

## 3. Explicit non-goals

Do not treat any of these as provided:

- **No authentication or authorization.** Anyone who can reach the port can
  read every whitelisted file in the root. The only boundary is
  `networkExposure: loopback`. **Do not expose DSH beyond loopback with this
  plugin installed** without adding an authenticating reverse proxy.
- **No confidentiality inside the root.** Any file with a whitelisted extension
  in the root is readable, including one an agent wrote by accident. Choose
  `root` deliberately; do not point it at `$HOME`.
- **No write path.** No upload, no delete, no rename, no publish. If a future
  version adds one, it needs its own threat model (CSRF, size, overwrite).
- **No per-session attribution.** The index is flat; it does not reveal which
  conversation produced which artifact.
- **No symlink following**, even to targets inside the root.
- **No recursion**, so a nested directory is invisible rather than enumerated.

---

## 4. Deployment guidance

- Keep the artifact root narrow and purpose-built (`$DSH_HOME/artifacts`), never
  a home directory or a source tree.
- Leave `csp` at `sandbox` unless a specific artifact needs scripts.
- Read the startup line `[dsh-artifact-index] artifact root = …` and confirm it
  names the directory you think it does. Every reported incident of "it is
  serving the wrong thing" starts with a root that was not what the operator
  assumed.
- Do not add `trustedHosts` entries for the network interface unless DSH itself
  is reachable there and you accept unauthenticated local file reads from that
  network.

---

## 5. Reporting

This is a personal-scale plugin with no security response process. If you find a
hole, the useful thing to do is write a failing test in `test/` and fix it: the
path and trust matrices are deliberately small and self-contained.
