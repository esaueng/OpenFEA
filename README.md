# OpenFEA

[![CI](https://github.com/esaueng/OpenFEA/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/esaueng/OpenFEA/actions/workflows/ci.yml)
[![Production health](https://github.com/esaueng/OpenFEA/actions/workflows/production-health.yml/badge.svg?branch=main)](https://github.com/esaueng/OpenFEA/actions/workflows/production-health.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

**Local-first browser CAD and finite element analysis for static, dynamic, modal, and thermal studies.**

Import CAD or create an analytic STEP part, assign materials and boundary conditions, mesh and solve in your browser, then inspect and share the results. OpenFEA Core runs locally; no cloud solver or account is required.

[Open the app](https://fea.esau.app) · [User guide](docs/user-guide/README.md) · [Validation](docs/validation/README.md) · [Local development](docs/local-development/README.md)

> OpenFEA is an engineering preview. Results are development-oriented analysis outputs, not certified analysis. Review the assumptions, material data, mesh quality, and validation evidence for each study.

## What you can do

| Area | Capabilities |
| --- | --- |
| Studies | Linear static stress, transient structural dynamics, modal analysis, and steady-state thermal conduction. |
| Geometry | STEP/STP, STL, and OBJ import; analytic parametric STEP parts; bracket, beam, and cantilever samples; face selection, dimensions, orientation, and open sections. |
| Materials and boundaries | Starter and project-specific materials, additive-manufacturing print settings, structural supports, prescribed temperatures, and thermal loads. |
| Structural loads | Total face force, pressure, surface traction, volume force, remote force, payload mass, and static equivalent bolt preload. Load cases, static combinations, and envelopes. |
| Meshing | Browser WebAssembly volume meshing, coarse through ultra presets, multi-body connections, and a static mesh-convergence ladder. |
| Results | Stress, displacement, safety factor, dynamic playback, natural frequencies and mode shapes, temperature, and heat flux as applicable. |
| Sharing | Portable `.openfea.json` projects with geometry and saved results, an offline HTML result viewer, selected-state CSV/VTU, and HTML/PDF reports. |

The [user guide](docs/user-guide/README.md) explains each workflow and its limits, including the initially closed linear contact approximation, equivalent bolt preload, and the guarded 150,000-DOF browser solve ceiling. The WebGPU package supports development benchmarks; automatic large-model GPU routing is currently disabled.

## Quick start

Use Node.js 22 and the pnpm version pinned in `package.json`. From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build:core
pnpm --filter @openfea/web dev
```

Open [localhost:5173](http://localhost:5173), choose **Load sample project** to try a prepared study, or create a project and import your own geometry. OpenFEA Core packages live in this monorepo under `packages/*`; no sibling checkout is needed.

The full product runs in the web app; `pnpm dev` is shorthand for the last command above. See [local development](docs/local-development/README.md).

## Local storage and privacy

- Geometry processing, meshing, solving, result inspection, and reports run in the browser. Workspace state uses localStorage and IndexedDB; **Save project** writes a portable `.openfea.json` file.
- After the app reports **Offline-ready**, its service worker has cached the app and analysis assets for offline use.
- If browser autosave runs out of space, OpenFEA asks before uploading a recovery snapshot. It encrypts the snapshot in the browser; the server stores ciphertext without the decryption key. Recovery backups expire after 30 days. Saving a local file remains available.
- Production enables Glimpse aggregate backend statistics. Browser usage analytics require an explicit opt-in under **Storage → Optional usage analytics** and remain off until granted. Withdrawal stops future collection; DNT/GPC suppress browser sends. Metrics use fixed categories and coarse buckets without model contents, filenames, project names, or visitor identifiers. See [Glimpse collection and controls](docs/glimpse.md) for payload limits and deployment/verification details.

## Development and verification

Build Core packages before typechecking consumers because package exports resolve to emitted `dist` files. The main checks are:

```bash
pnpm build:core
pnpm --filter "./packages/*" --if-present test
node scripts/verify-cloudflare-config.mjs
pnpm typecheck
pnpm test
pnpm verify:step-selection-browser
pnpm verify:project-results-browser
pnpm build:cloudflare
pnpm --filter @openfea/web check:bundle
```

For the optional built-worker and offline mesh proofs, first build with `VITE_BROWSER_PROOF=1 pnpm --filter @openfea/web build`. This opt-in verification artifact includes the URL-driven mesh harness; normal release builds remove it. Threaded Gmsh requires the checked-in COOP/COEP headers on both the app shell and workers; Vite development and preview serve the same isolation headers. Rebuild normally before deploying.

The browser checks require Chrome or Chromium; set `CHROME_BIN` if auto-detection cannot find it. STEP selection uses ports 5198/9336 and project/results checks use 5199/9337. The bundle check must follow the production build. [CI](.github/workflows/ci.yml) delegates to the pinned [fleet workflow](.github/workflows/fleet-ci.yml); it also enforces runner isolation and routing policy.

`pnpm build` and `pnpm build:cloudflare` both build Core and the production web app. `pnpm verify:perf` builds and checks web performance.

## Production hosting

The production app is [fea.esau.app](https://fea.esau.app). A Cloudflare Worker serves static assets, encrypted recovery backups, the analytics relay, and health routes. Simulation jobs stay in the browser. The production build compresses Gmsh WASM before generating the service-worker precache and checking bundle budgets.

For an authorized production deployment:

```bash
pnpm deploy:cloudflare
```

This verifies the configuration, builds the app, and deploys with [wrangler.jsonc](wrangler.jsonc). For Cloudflare Builds, use:

```text
Build command: pnpm run build
Deploy command: npx wrangler deploy
```

Non-production branch builds use `npx wrangler preview`. The checked-in `previews` block disables analytics and omits production service, R2 and rate-limiter bindings. Browser-local modeling and simulation remain available; encrypted cloud recovery returns unavailable on previews. Preview resource isolation is enforced by `verify:cloudflare-config`.

`pnpm deploy:cloudflare` is also a supported deploy command. Do not use `npx wrangler versions upload` for the production Worker: version uploads cannot apply the retired Durable Object cleanup migration. The separate `deploy:cloudflare:static` target is non-production and omits the production domain. See [local development](docs/local-development/README.md) and [cloud retirement](docs/cloud-retirement.md) for deployment commands and the one-off retired Durable Object cleanup procedure.

## Production Uptime

| Endpoint | Purpose |
| --- | --- |
| [`GET /health`](https://fea.esau.app/health) | Release contract: expected Worker/service identities and `solverRuntime: "browser-openfea-core"`. The [production-health workflow](.github/workflows/production-health.yml) checks it every 30 minutes. |
| [`GET /healthz`](https://fea.esau.app/healthz) or `HEAD /healthz` | Public Worker liveness without storage or upstream requests. Returns HTTP 200, JSON `status: "ok"` for GET, and `Cache-Control: no-store`; other methods return 405. |

Neither endpoint verifies browser geometry or solver execution. Retired cloud solve routes return HTTP 410. Cloudflare Access, WAF, and bot challenges run before the Worker; monitoring exceptions must be scoped to the intended hostname and exact GET/HEAD `/healthz` route and verified from the monitor's network.

## Repository layout

| Path | Role |
| --- | --- |
| `apps/openfea-web` | Production React/Vite workspace and Cloudflare Worker. |
| `packages/*` | OpenFEA Core model, examples, CPU solver, WebGPU solver, and viewer. |
| `libs/*` | Schema, units, materials, samples, CAD/STEP and mesh intake, study validation, solve pipeline, and Core adapter. |
| `examples/*`, `docs/*` | Sample fixtures, user documentation, architecture, and validation evidence. |

CAD topology references remain the source of truth for supports, loads, connections, and named selections. Meshes are generated artifacts; results and reports belong to their study run. Computed FEA, preview estimates, benchmarks, and historical cloud results retain distinct provenance. See [architecture](docs/architecture/README.md).

## Compatibility

New project downloads use `.openfea.json` and the `openfea-local-project` envelope. Existing `.opencae` / `.opencae.json` projects and browser autosaves remain readable. Packages and workspace paths use `@openfea/*` and `openfea-*`.

Some storage keys, Core schema/provenance identifiers, backup headers, the `opencae-project-backups` bucket, and archived fixtures retain their original identifiers for compatibility. Renaming infrastructure requires a separate migration.

## Documentation

- [User guide](docs/user-guide/README.md)
- [Architecture](docs/architecture/README.md)
- [Local development](docs/local-development/README.md)
- [Project file format](docs/file-format/README.md)
- [Validation](docs/validation/README.md)
- [Analytics and privacy](docs/glimpse.md)
- [Cloud retirement](docs/cloud-retirement.md)

## License

OpenFEA source code is licensed under [Apache-2.0](LICENSE). Separately licensed third-party components, including OCCT/occt-import-js, retain their own licenses; see [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Copyright 2026 Esau Engineering. The OpenFEA name and logo are trademarks of Esau Engineering.
