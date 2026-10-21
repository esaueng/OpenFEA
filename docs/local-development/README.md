# Local Development

Use Node.js 22 and the pnpm version pinned in the root `package.json`. Install dependencies, build the emitted Core packages, and start the browser workspace:

```bash
pnpm install --frozen-lockfile
pnpm build:core
pnpm --filter @openfea/web dev
```

OpenFEA Core packages are part of this monorepo under `packages/*`. `pnpm build:core` only builds those local packages; it does not install dependencies, clone another repository, or mutate the lockfile. CI and local verification should use `pnpm install --frozen-lockfile`.

The web app runs at `http://localhost:5173` and handles geometry, meshing, solves, results, and reports locally. `pnpm dev` is shorthand for `pnpm --filter @openfea/web dev`.

## Commands

```bash
pnpm build
pnpm test
pnpm verify:perf
```

- `pnpm build` builds the Core packages and the web app.
- `pnpm test` runs the Vitest suite across the workspace.
- `pnpm verify:perf` builds the web app and runs the web performance verifier.

## Cloudflare Commands

```bash
pnpm deploy:cloudflare:dry-run
pnpm deploy:cloudflare
pnpm deploy:cloudflare:retired-do-cleanup
pnpm deploy:cloudflare:static:dry-run
pnpm deploy:cloudflare:static
```

Use the default Cloudflare deploy for the production app domain. It deploys the local-first Worker with the default `wrangler.jsonc` (static assets + security headers, no solver bindings) and targets `openfea`. Use the static commands only for the explicitly non-production `openfea-static` Worker. (The cloud container deploy commands were retired in July 2026; see [docs/cloud-retirement.md](../cloud-retirement.md).)

Use `pnpm deploy:cloudflare:retired-do-cleanup` only once if Cloudflare still has the retired `OpenCaeCoreCloudContainer` Durable Object class recorded and rejects the normal deploy with code `10064`.

Deploy and CI runners may start from a standalone checkout of this repo. Use `pnpm install --frozen-lockfile` followed by `pnpm run build` or another script that runs `pnpm build:core`.
