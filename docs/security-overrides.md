# Security Overrides

`pnpm.overrides` pins in root `package.json` for high-severity transitive vulnerabilities
that are not cleared by direct dependency upgrades alone.

| Package path | Pinned version | Advisory(s) | Date |
|---|---|---|---|
| `micromatch>picomatch` | 2.3.2 | GHSA-c2c7-rcm5-vvqj | 2026-07-07 |
| `path-to-regexp` | 8.4.2 | GHSA-j3q9-mxjg-w52f | 2026-07-07 |
| `fast-uri` | 3.1.3 | GHSA-q3j6-qgpj-74h6, GHSA-v39h-62p7-jpjc | 2026-07-07 |
| `vitest>picomatch` | 4.0.5 | GHSA-c2c7-rcm5-vvqj | 2026-07-07 |
| `vitest>vite` | 7.3.6 | GHSA-v2wj-q39q-566r, GHSA-p9ff-h696-f583, GHSA-fx2h-pf6j-xcff | 2026-07-07 |
| `jsdom>undici` | 7.28.0 | GHSA-vmh5-mc38-953g, GHSA-vxpw-j846-p89q, GHSA-hm92-r4w5-c3mj | 2026-07-07 |
| `@dotenvx/dotenvx>picomatch` | 4.0.5 | GHSA-c2c7-rcm5-vvqj | 2026-07-07 |

Direct upgrades performed alongside these overrides:

- `next` 16.2.0 → 16.2.10 (dashboard)
- `hono` ^4.12.8 → ^4.12.28 (concierge)
- `better-auth` 1.6.11 → 1.6.23 (dashboard; moves `vitest` from a regular dependency to a peer dependency, eliminating most dev-graph audit noise without overrides)
