# Roadmap

Current priorities live in [plan 036](../../plans/036-product-roadmap-2026-q4.md).
This page records the OpenFEA Core phases and where each one stands as of
2026-10-21 (`main` at `9d36aa2`).

The original plan made WebGPU the production solver. What shipped is a CPU
sparse solver (CSR, SSOR/Jacobi-preconditioned CG) running in a browser worker,
with WebGPU kept as a development benchmark path.

## Completed phases

| Phase | Scope | Outcome |
| - | - | - |
| 0 | Repository foundation | Done. Now part of the OpenFEA monorepo under `packages/*`. |
| 1 | Core FEA model | Done. Solver-neutral JSON model, validation, typed-array normalization, `m-N-s-Pa` and `mm-N-s-MPa` unit systems. |
| 2 | CPU reference Tet4 solver | Done, then superseded. The dense reference grew into the production CSR solver for Tet4 and Tet10. |
| 3–5 | WebGPU infrastructure, matrix-free Tet4 operator, CG | Partial. The matrix-free Tet4 operator runs on the GPU, but CG reductions and convergence checks run on the CPU each iteration. Automatic routing is disabled (`WEBGPU_TET4_AUTOMATIC_ENABLED = false`). |
| 6 | Post-processing and visualization | Done. Stress measures, displacement, safety factor, smoothing that is display-only. |
| 7 | Product MVP workflow | Done. The OpenFEA web app. |
| 8 | Performance pass | Partial. A ~100k-DOF browser checkpoint exists; the 150k guarded ceiling has not been benchmarked (plan 036 R5.1). |
| 9 | Solver expansion | Done on `main`. CSR/SSOR solving to a guarded 150k DOF, transient Newmark dynamics, modal subspace iteration, steady-state Tet4/Tet10 conduction, tie/fuse connections and initially closed linear frictionless contact. |
| 10 | Trust and sharing | Done. In-app validation gallery with live worker reruns, offline HTML result viewer, PDF reports, selected-state CSV/VTU. |

## Open phase

### Phase 11 — Nonlinear contact and GPU residency

Not started. Contact is still a bilateral penalty that cannot separate, and the
CG loop is not GPU-resident. Plan 036 schedules these as R6.2 (active-set
contact) and R5.3 (GPU-resident CG, after the benchmark ladder in R5.1).
Release ceilings are to come from per-browser and per-device benchmarks, not
from the guarded limits.
