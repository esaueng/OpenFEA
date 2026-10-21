# OpenFEA Core

## Mission
OpenFEA Core enables local browser-based finite element analysis.

It is the browser-native FEA core of the OpenFEA web app. Production solves run locally in the browser on the CPU sparse solver (`@openfea/solver-cpu`). A matrix-free Tet4 WebGPU operator (`@openfea/solver-webgpu`) exists for explicit experiments, but automatic WebGPU routing is disabled (`WEBGPU_TET4_AUTOMATIC_ENABLED = false` in `packages/solver-webgpu/src/matrix-free.ts`) until CG vectors and reductions stay GPU-resident and end-to-end browser benchmarks establish a safe release ceiling. WebAssembly is used for in-browser preprocessing such as Gmsh meshing.

OpenFEA Core is not a port of CalculiX, a CUDA solver, or a server-side solver.

## Repository
OpenFEA Core lives in the OpenFEA monorepo. Its packages are under `packages/*` (`@openfea/core`, `@openfea/examples`, `@openfea/solver-cpu`, `@openfea/solver-webgpu`, `@openfea/viewer`) and its reference docs are under `docs/core/`. The former standalone `openfea-core` repository was consolidated here in July 2026; see `docs/cloud-retirement.md`.

## First Product Target
A user can open a web app, load a simple Tet4 mesh, assign a linear elastic material, apply fixed supports and nodal forces, run a local in-browser solve, view displacement and von Mises stress, and export result data.

## Phase 0 Scope
Phase 0 establishes repository infrastructure only. It does not implement FEA model types, solver kernels, WebAssembly solving, visualization, mesh loading, or server-side solving.
