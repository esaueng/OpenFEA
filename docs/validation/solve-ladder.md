# Solve ladder: browser CPU solver envelope

Plan 036 R5.1. This is the measurement step for plan 024 Release 4. It measures the browser CPU solver at about 30k, 75k and 150k DOF, including the guarded 150,000-DOF product ceiling (`DEFAULT_STRUCTURAL_MAX_DOFS` in `packages/solver-cpu/src/limits.ts`). Before this, only the approximately 100k checkpoint had ever been measured (`scripts/verify-100k-solve.mjs`).

This document records measurements. **It does not change the ceiling or any solver default.**

## Measured envelope (2026-10-21, Chromium 141, Linux x64)

**Rungs run:** all 20 cases, Chromium only. **Rungs failed:** none (every gate passed). **Not run:** WebKit. The Playwright WebKit download (`cdn.playwright.dev`) is blocked by the network policy of the environment that produced these numbers, so no JavaScriptCore numbers exist for this ladder yet.

**Machine:** cloud container, Intel Xeon @ 2.10 GHz, 4 logical CPUs, 16 GB RAM, no swap, Linux 6.18 x64, Node 22.22.0. **Browser:** Chromium 141.0.7390.37, headless (`--headless=new --disable-gpu`; `--no-sandbox` because the container runs as root). Each case got a fresh browser process, and nothing else ran on the machine during the measurements. Raw results: [`solve-ladder/2026-10-21-chromium.json`](solve-ladder/2026-10-21-chromium.json).

**Measured envelope.** At the 150k ceiling the solver completes, within budget and in equilibrium:

| Variant at ≤150k DOF | Solve time | CG iterations | Worker heap | Renderer peak |
|---|---|---|---|---|
| Well-conditioned (block), Tet4 / Tet10 | 18.5 s / 59 s | 369 / 479 | 0.92 / 1.00 GB | 1.35 / 1.08 GB |
| Ill-conditioned (slender L/H = 50), Tet4 / Tet10 | 4.9 min / 22 min | 6,240 / 11,221 | 1.13 / 0.97 GB | 1.09 / 1.06 GB |

The 1.5 GB JS-heap and 2 GB process budgets held at every rung. The largest readings were 1.13 GB worker heap (slender Tet4 150k) and 1.35 GB renderer peak (block Tet4 150k). Neither includes gmsh meshing, which `verify-100k-solve.mjs` measured at about 1.1 GB on its own. Wall time, not memory, is what limits ill-conditioned models.

Full table. *Solve* is CG only for static, and the whole `solveCore*` call for modal and dynamic. *Final rel. residual* for dynamic is the last Newmark step.

| Case | DOF total / free | Assemble s | Solve s | Iterations | Precond | Final rel. residual | Worker heap MB | Process peak MB | Parity / gates |
|---|---|---|---|---|---|---|---|---|---|
| `block-tet4-30k-static` | 29,478 / 28,611 | 0.9 | 1.6 | 213 CG | ssor | 8.4e-11 | 199 | 652 | pass |
| `block-tet4-30k-modal` | 29,478 / 28,611 | 0.5 | 62.5 | 12 subspace, 3/3 modes | jacobi | – | 260 | 337 | pass |
| `block-tet4-30k-dynamic` | 29,478 / 28,611 | 0.5 | 40.0 | 2,413 CG (613 max/step) | jacobi | 9.9e-11 | 246 | 669 | pass |
| `block-tet10-30k-static` | 28,611 / 27,744 | 1.2 | 4.7 | 275 CG | ssor | 8.6e-11 | 219 | 578 | pass |
| `block-tet10-30k-modal` | 28,611 / 27,744 | 0.6 | 103 | 10 subspace, 3/3 modes | jacobi | – | 220 | 274 | pass |
| `block-tet10-30k-dynamic` | 28,611 / 27,744 | 0.6 | 86.6 | 2,853 CG (723 max/step) | jacobi | 9.6e-11 | 169 | 368 | pass |
| `slender-tet4-30k-static` | 29,916 / 29,808 | 1.0 | 27.1 | 3,612 CG | ssor | 1.9e-07 | 144 | 615 | pass |
| `slender-tet4-30k-modal` | 29,916 / 29,808 | 0.4 | 1,530 | 30 subspace, 1/3 modes | jacobi | – | 263 | 337 | pass |
| `slender-tet4-30k-dynamic` | 29,916 / 29,808 | 0.4 | 373 | 21,386 CG (5,596 max/step) | jacobi | 9.7e-11 | 183 | 398 | pass |
| `slender-tet10-30k-static` | 29,841 / 29,694 | 1.1 | 114 | 6,225 CG | ssor | 4.1e-07 | 273 | 277 | pass |
| `slender-tet10-30k-modal` | 29,841 / 29,694 | 0.6 | 4,077 | 30 subspace, 1/3 modes | jacobi | – | 200 | 214 | pass |
| `slender-tet10-30k-dynamic` | 29,841 / 29,694 | 0.5 | 883 | 27,301 CG (7,164 max/step) | jacobi | 9.9e-11 | 200 | 367 | pass |
| `block-tet4-75k-static` | 74,589 / 73,002 | 3.0 | 6.9 | 293 CG | ssor | 8.6e-11 | 550 | 1,023 | pass |
| `block-tet10-75k-static` | 74,589 / 73,002 | 3.7 | 22.0 | 379 CG | ssor | 9.4e-11 | 586 | 1,046 | pass |
| `slender-tet4-75k-static` | 74,880 / 74,688 | 2.1 | 99.2 | 4,678 CG | ssor | 3.7e-07 | 626 | 928 | pass |
| `slender-tet10-75k-static` | 74,601 / 74,358 | 3.5 | 467 | 8,433 CG | ssor | 7.3e-07 | 688 | 411 | pass |
| `block-tet4-150k-static` | 148,857 / 146,334 | 4.7 | 18.5 | 369 CG | ssor | 9.0e-11 | 923 | 1,346 | pass |
| `block-tet10-150k-static` | 148,857 / 146,334 | 6.9 | 59.2 | 479 CG | ssor | 9.5e-11 | 1,004 | 1,077 | pass |
| `slender-tet4-150k-static` | 150,000 / 149,700 | 4.3 | 295 | 6,240 CG | ssor | 6.4e-07 | 1,132 | 1,090 | pass |
| `slender-tet10-150k-static` | 149,919 / 149,556 | 6.8 | 1,325 | 11,221 CG | ssor | 1.1e-06 | 972 | 1,058 | pass |


## What is measured

- **Fixtures** come from `apps/openfea-web/src/workers/solveLadderFixtures.ts`. They are generated deterministically from a few integers, so no mesh binaries are committed.
  - Structured hex grids are split into six tets (Kuhn split, which is conforming). Tet10 is made by midside elevation.
  - Each fixture has an FNV-1a fingerprint, so a parity reference applies only to bit-identical input.
  - Units are mm-N-s-MPa. The material is steel: E = 200 GPa, ν = 0.3, ρ = 7.85e-9 t/mm³. The x = 0 face is clamped, and a consistent surface force is applied to the x = L face (−z direction).
  - **block** (well-conditioned): 200 × 100 × 100 mm, 10 kN tip shear.
  - **slender** (ill-conditioned): 1000 × 20 × 20 mm (L/H = 50), 100 N tip shear. This is bending-dominated, and the stiffness condition number grows with the aspect ratio.
  - Grid cells stay within a 2:1 edge ratio. The geometry drives conditioning, not element distortion.
  - Rung targets are **total** DOF, because the product ceiling counts constrained DOF too. The 150k rung therefore lands at 148,857–150,000 total DOF and 146,334–149,700 free DOF.
- **Solver path** is `apps/openfea-web/src/workers/solveLadderRun.ts`, running in a dedicated worker.
  - It uses the production `BROWSER_SOLVE_LIMITS` with `boundedSolverSettings`: maxIterations 50,000, tolerance 1e-10, and the production auto preconditioner (SSOR for static).
  - Static solves call the two public halves of `solveCoreStatic`, `prepareStaticLinearTetSystem` then `solvePreparedStaticLoadCase`. This lets assembly and CG time be measured directly.
  - Modal and dynamic go through `solveCoreModal` and `solveCoreDynamic`. Both default to the Jacobi preconditioner.
  - The ladder skips STEP import, gmsh meshing and study adaptation. Those are covered by `scripts/verify-100k-solve.mjs`. Meshing memory (about 1.1 GB, per that script) is not included here.
- **Timings:**
  - *Assemble* is normalization excluded: element loop, CSR build and constraint reduction.
  - *Solve* runs from the RHS reduction to the final CG progress event.
  - Recovery (stress, reactions, Core result build) is in the JSON but not in this table.
- **CG iterations and final relative residual** come from solver diagnostics. The residual is the true ‖Ku − f‖/‖f‖ over free DOF, recomputed after CG, not CG's recursively updated residual.
- **Memory**, each labelled with its method:
  - *Worker heap*: CDP `Runtime.getHeapUsage` on the worker target (`usedSize + backingStorageSize`), polled every 250 ms. Chromium answers through a V8 interrupt, so it samples during the synchronous solve. It includes ArrayBuffer stores (CSR matrix, CG vectors). Chromium does not expose `performance.memory` inside workers.
  - *Process peak*: Linux `VmHWM` (kernel lifetime peak RSS) of the largest browser child process. In every run that was the renderer that hosts the page and the worker. A fresh browser is launched for each case. This number includes the whole app shell that the harness page loads.
  - `performance.measureUserAgentSpecificMemory()` is sampled from the main thread under COOP/COEP. It returned only 1–23 point samples per case, all under 6 MB, and never captured the busy worker. It is kept in the JSON but is **not** a usable peak metric.
- **Parity gates**, applied per case by `scripts/verify-solve-ladder.mjs`:
  - Reaction equilibrium: |ΣR_z + F_z| / |F_z| ≤ 1e-6.
  - Browser vs the Node V8 reference (`solve-ladder/reference-node.json`, same code and settings, produced by `scripts/solve-ladder-node.ts`) within `LADDER_PARITY_REL_TOL = 1e-6`. Static compares tip mean u_z, max |u| and reaction; modal compares frequencies; dynamic compares peak |u|.
  - Slender Tet10 tip mean u_z vs Timoshenko beam theory (12.504 mm) within 1%. Tet4 is excluded because it locks in bending: 10.8–11.9 mm across the rungs, converging from below.
  - Memory budget, matching the stop lines of `verify-100k-solve.mjs`: JS heap ≤ 1.5 GB and process ≤ 2 GB.

## Findings

1. **The 150k ceiling is reachable in Chromium.** All four 150k static cases pass every gate. The block variant solves in under a minute. The slender Tet10 variant takes 22 min of CG, which is past what most users will wait for, but it does finish.
2. **Results are bit-identical to Node.** Chromium matched the Node V8 reference exactly (relative delta 0) on every static and dynamic quantity, and modal frequencies agree within 4e-11. The 1e-6 parity tolerance is therefore conservative for V8 and is meant to absorb JavaScriptCore `Math` differences once WebKit runs.
3. **Slender static solves stop short of the requested tolerance.** CG reports convergence at its recursive relative residual of 1e-10. The true residual recomputed afterwards, ‖Ku − f‖/‖f‖, is only 1.9e-7 at 30k Tet4, rising to 1.1e-6 at 150k Tet10. This is residual drift in long, ill-conditioned SSOR-CG runs. The block variant reaches 8–9.5e-11 at every rung.

   The answers are still physically sound. Reactions balance the load to 1.2e-7 or better, and slender Tet10 tip deflection is within 0.16–0.21% of Timoshenko beam theory at every rung.

   From 30k to 150k the iteration count grows about 1.7–1.8× for both variants. Slender needs 17–23× more iterations at every rung (6,240 and 11,221 at 150k, against 369 and 479 for block). That absolute gap is what R5.2 (preconditioner evaluation) should close. The diagnostics' `converged: true` does not reflect the true residual.
4. **Slender modal drops the fundamental modes at 30k.** Requested 3 modes, converged 1 after hitting the 30-iteration subspace cap.

   The solver labels it correctly as **mode 3** (Tet4 107.3 Hz, Tet10 102.1 Hz) and sets `partialConvergenceWarning`. Modes 1 and 2 stalled at scaled residuals of 2.5e-6 and 2.0e-6, just above the 1e-6 tolerance, so they were dropped from the result. These are the near-degenerate first bending pair (y and z), about 16.3 Hz by beam theory, and the second bending mode is about 102 Hz.

   The same fixture at about 10k DOF converges all three in 8 iterations: 18.2, 20.4 and 114 Hz, with Tet4 stiffening the values. So on slender parts, convergence of the near-degenerate pair degrades as the mesh is refined.

   The result is not mislabelled, but a user asking for the first three modes of a slender part gets only a higher mode plus a warning. This needs a follow-up in the modal solver: more iterations or a larger block, a tighter inner solve, or SSOR. That work is out of scope for this measurement PR and is not done here. The block variant converges 3/3 in 10–12 iterations.
5. **The Jacobi baseline for R5.2 at 30k:**
   - Modal: block 62–103 s; slender 25.5 min (Tet4) and 68 min (Tet10).
   - Dynamic, 20 Newmark steps: block 2,413–2,853 CG iterations in total, 40–87 s. Slender 21,386–27,301 iterations, with up to 7,164 in one step, taking 6.2–14.7 min.
   - Static uses SSOR. Modal and dynamic still use Jacobi.
6. **Memory is dominated by ArrayBuffers and scales linearly.**
   - Worker heap is 92–99% ArrayBuffer storage: the CSR matrix plus CG and recovery vectors. The V8 object heap stays at 26 MB or less.
   - The peak is roughly 6.2–7.5 KB per DOF at 150k, and 7.4–9.2 KB per DOF at 75k.
   - Renderer peaks add up to about 0.45 GB on top of the worker heap for the app shell the harness page loads.
7. **Open measurement question.** On three runs (slender Tet10 30k, slender Tet10 75k and slender Tet4 150k), the renderer's `VmHWM` came out at or below the V8-accounted worker `backingStorageSize` (for example 277 MB process vs 270 MB ArrayBuffers). Either V8 accounts for ArrayBuffer memory that is not resident, or the kernel peak is attributed differently for long runs. Treat both columns as estimates. The budget gate uses the larger of the two.
8. **Timing noise.** Three repeats of `slender-tet4-30k-static` with heap polling off, at 1000 ms and at 250 ms gave 30.6 s, 28.6 s and 30.2 s. That is about 7% spread, with no measurable polling cost.

## Running it

```sh
pnpm build:core
VITE_BROWSER_PROOF=1 pnpm --filter @openfea/web build
pnpm verify:solve-ladder                      # all 20 cases, Chromium + WebKit if available
pnpm verify:solve-ladder -- --rungs=30k       # subset by rung
pnpm verify:solve-ladder -- --cases=block-tet4-150k-static
# Refresh the Node reference only when the solver or fixtures change:
pnpm exec tsx scripts/solve-ladder-node.ts [--cases=...] [--rungs=...]
```

`CHROME_BIN` overrides browser discovery. The default is `/opt/pw-browsers/chromium` in cloud containers. For WebKit, set `PLAYWRIGHT_WEBKIT_DIR` to a scratch directory that has `playwright-webkit` and its browser installed. It is never a repo dependency. Results are written to `docs/validation/solve-ladder/<date>-<engine>.json` (override with `LADDER_OUT`), and the Markdown table is printed. The script exits non-zero when any executed case fails a gate.

## Why it is manual, not CI

- **Runtime.** The full ladder takes about 2.7 h of solver time on the machine above. Slender Tet10 30k modal alone takes over an hour, and slender Tet10 150k static takes 22 min. That is far beyond a CI budget.
- **Timing noise.** Wall time depends on the runner's CPU. Repeated runs of one case differed by about 7% here (28.6–30.6 s for slender Tet4 30k). Shared CI runners would turn timing gates into flakes. The gates the ladder does enforce (parity, equilibrium, memory budget) do not need the large rungs to catch regressions; the unit suite already covers solver correctness.
- **Browser binaries.** WebKit needs a Playwright browser download that is not available in every environment.

## Proposed CI smoke rung (not wired)

`block-tet4-30k-static` solves in 1.6 s of CG, about 4 s in the solver end to end and 15–25 s of wall time including browser start-up. It converges to 8.4e-11 in a fixed 213 iterations and is deterministic. Its gates are parity with Node, equilibrium and the memory budget, which are not timing gates, so it would be stable on shared runners. A good candidate is a `pnpm verify:solve-ladder -- --cases=block-tet4-30k-static --engines=chromium` step in the `browser` job, next to `verify:step-selection-browser`. That decision belongs in a separate PR.
