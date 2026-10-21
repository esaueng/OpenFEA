# OpenFEA Core

## Mission
OpenFEA Core enables local browser-based finite element analysis.

Production solves run in a browser Web Worker on the CPU sparse solver (`@openfea/solver-cpu`). The WebGPU matrix-free Tet4 operator (`@openfea/solver-webgpu`) is available for explicit experiments only; automatic routing to it is disabled (`WEBGPU_TET4_AUTOMATIC_ENABLED = false` in `packages/solver-webgpu/src/matrix-free.ts`) until CG vectors and reductions stay GPU-resident and browser benchmarks establish a safe release ceiling.

OpenFEA Core is not a port of CalculiX, a CUDA solver, or a server-side solver.

## Repository
OpenFEA Core lives in the OpenFEA monorepo (`esaueng/OpenFEA`) as the `packages/*` workspace packages (`@openfea/core`, `@openfea/solver-cpu`, `@openfea/solver-webgpu`, `@openfea/viewer`, `@openfea/examples`), not in a separate repository.

## First Product Target
A user can open a web app, load a simple Tet4 mesh, assign a linear elastic material, apply fixed supports and nodal forces, run a local in-browser solve, view displacement and von Mises stress, and export result data.

## Phase 0 Scope (historical)
Phase 0 established repository infrastructure only. It did not implement FEA model types, solver kernels, WebAssembly solving, visualization, mesh loading, or server-side solving.
