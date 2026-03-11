# Security Remediation Todo

Tracking list for issues identified in [security-audit.md](./security-audit.md).

---

## P0 — Immediate

- [x] **C-1: HMAC oracle + low entropy access code** — Replace human-readable access code (~20 bits) with 128-bit persistent token, add `--refresh-token` CLI flag
- [ ] **H-1: No TLS** — Add native TLS support or document that a TLS-terminating reverse proxy is required for non-localhost deployments

## P1 — ASAP

- [ ] **C-2: `X-Internal-Proxy` static bypass** — Replace hardcoded `"node-connector"` string with a cryptographically random token generated at startup
- [ ] **C-3: One-way authentication** — Make hub-node handshake mutual (hub must also challenge node to prove identity)
- [ ] **H-2: No WebSocket Origin checking** — Validate `Origin` / `Host` headers on WebSocket upgrade, reject cross-origin requests

## P2 — Planned

- [ ] **C-4: Unrestricted PTY + env leak** — Validate/allowlist `cwd`, sanitize environment variables passed to spawned shells
- [ ] **H-3: Default `bypassPermissions`** — Make permission mode configurable; preserve original mode on session reactivation
- [ ] **H-4: Case-insensitive access code comparison** — ~~No longer applicable (replaced by exact hex token match)~~
- [ ] **M-1: No API rate limiting** — Add rate limiting to session/terminal creation endpoints
- [ ] **M-2: No `cwd` validation** — Validate `cwd` against an allowlist of permitted project directories

## P3 — Hardening

- [ ] **M-3: Node ID truncated to 8 chars** — Use full UUID or at least 16 characters
- [ ] **M-4: 50MB request body limit** — Use route-specific body limits
- [ ] **M-5: Hub proxy has no path allowlist** — Allowlist permitted API paths for hub proxy
- [ ] **M-6: Error messages expose internal details** — Return generic errors in production, log full details server-side
- [ ] **M-7: Access code logged to stdout** — ~~Partially mitigated (token is logged once at startup; consider `--quiet` flag)~~
- [ ] **M-8: Server binds to all interfaces** — Default node mode to `127.0.0.1`; only hub mode binds `0.0.0.0`
- [ ] **M-9: Rate limiter is in-memory and IP-based** — Consider persistent store and distributed brute-force protection
- [ ] **L-1: `SameSite: lax` limited CSRF protection** — Evaluate upgrading to `strict` or adding CSRF tokens
- [ ] **L-2: No security headers** — Add `helmet` middleware (HSTS, X-Content-Type-Options, X-Frame-Options, CSP)
- [ ] **L-3: `delete process.env.CLAUDECODE`** — Document the trade-off; consider scoping the removal
- [ ] **L-4: Session secret is ephemeral** — Consider persisting session secret for cross-restart session continuity
- [ ] **L-5: `no-auth` proof in challenge-response** — Require explicit opt-in for unauthenticated hub connections
