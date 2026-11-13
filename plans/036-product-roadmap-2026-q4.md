# 036 — Product roadmap, 2026-Q4 revision

## Status

Proposed on 2026-10-21 against `main` at `9d36aa2`. Decisions D1–D5 were
accepted the same day and R0 started.

Progress re-verified on 2026-11-12 against `main` at `12cf5fa`: R0 is done
except 0.10 (`packages/viewer`). R1.3, R2.1 and R3.1 are done. R5.1 is
partial (Chromium only). Each item below carries its commits and PR.
On 2026-11-13, 0.10 was closed by deleting `packages/viewer` after parity
tests (`apps/openfea-web/src/components/solverSurfaceRenderParity.test.ts`), so R0 is done.
R2.2 (local sizing per face) is done (#227); its Kt, mm vs m and browser gates pass.

This plan supersedes the ordering in plan 024 and reopens the deferred
decisions 032 and 033 with a recommendation. Plans 024 (Releases 6–8) and
029–035 stay valid as specifications; this document decides what comes next
and in what order.

The baseline below was taken from the code, not from earlier plans. Most of
plans 001–025 have landed or no longer apply, and `plans/README.md` had stopped
saying so. That index is corrected in the same change as this plan.

## Where the product stands

| Area | Today (verified at `9d36aa2`; updated at `12cf5fa`) | Main gap |
| - | - | - |
| Studies | Linear static, Newmark transient, modal (block shift-invert subspace, 1–10 modes), steady thermal conduction. | No buckling, harmonic, transient thermal, convection or thermal stress. |
| Elements | Tet4 and Tet10 only. | No shells or beams. Thin parts cost DOF. |
| Supports | Fixed (always x, y and z), prescribed displacement (one component per constraint), prescribed temperature. | No symmetry, roller, per-component fixed, elastic or remote-displacement support. (The unreachable "Coming soon" menu was removed in `d020bba`, #191.) |
| Loads | Force, pressure, traction, volume force, gravity/payload, remote force (distributed wrench), equivalent bolt preload (static), heat flux, heat generation. Tri6 loads are consistent and area-weighted. | No bearing load. No local coordinate systems. |
| Selection | Multi-face supports and loads through an "Additional faces" checklist. Ctrl/Cmd-click multi-pick and a named-selection manager (#225; R1.2). | — |
| Materials | 22 isotropic linear materials, custom project materials, AM print settings applied as homogenized isotropic scale factors. Per-body material assignments mapped to element blocks (`27722d0`, `4edeae6`, #203). | No CTE and no orthotropy. |
| Contact | Tie, fuse, and frictionless linear penalty contact that starts closed and stays closed. | No separation, gap or friction. |
| Meshing | Gmsh WASM with coarse to ultra presets, automatic quality floor, Tet10 elevation, static convergence ladder. Mesh quality metrics in the Mesh panel, viewer and report (`9b3a3fd`, `f15ea2b`, #198). | No local sizing per face or edge. |
| Results | Stress measures, displacement, safety factor (yield over von Mises), probes, one axis-aligned section, envelopes, playback, PDF, HTML viewer, CSV/VTU of the selected state. Modal mass participation per direction (`cc90be1`, #196). | No error indicator, linearized stress, run comparison or design sweep. |
| Geometry | STEP/STP solvable; STL/OBJ preview-only by decision 031B; four parametric parts. | No IGES. No defeaturing. |
| Scale | 150k DOF guarded ceiling. SSOR CG for static and thermal, Jacobi for modal and dynamic. The ceiling is benchmarked in Chromium (`docs/validation/solve-ladder.md`, `4f9541b`, #197). | No WebKit numbers and no CI smoke rung. Slender solves stop short of the true residual and slender modal can drop modes (see Unscheduled findings). WebGPU automatic routing is off because the CG loop is not GPU-resident. |
| Code health | Dependencies current (React 19, Vite 8, Vitest 5, Zod 4). Backend fallbacks removed from the browser. Reference backend deleted (`88b5975`, #193). Type-aware ESLint in CI (`76653ba`, `ed3ad4f`, #195). | `CadViewer.tsx` 7,699 lines and `WorkspaceApp.tsx` 3,484 lines. `packages/viewer` deleted after parity tests (R0.10). |

## Principles

These carry over from plan 024 and apply to every release below.

- Preserve Z-up, `coordinateSystem.solverUnits`, `renderCoordinateSpace`, the
  project file format and result provenance tiers. A new persisted field ships
  with a backward-reading fixture and a format note in `docs/file-format/`.
- Compare computed floats with named, scale-aware tolerances from the existing
  policy modules. Do not add bare `1e-12` literals.
- Every new analysis or boundary condition ships with a closed-form benchmark,
  an mm/MPa vs m/Pa equivalence test, a load or energy balance check, and a
  browser run. It is labeled development-grade until those pass.
- Label every approximation in the UI, diagnostics and report: penalty
  methods, modal truncation, linear buckling, homogenized AM properties.
- The 150k DOF ceiling is a product limit, not a promise. Raise it only on
  benchmark evidence (R5).

## Release train

Effort: S ≤ 2 days, M ≤ 1 week, L ≤ 3 weeks, XL longer.
Each numbered item is one PR unless it says otherwise.

### R0 — Truth and hygiene (now, all S unless marked)

| # | Item | Why |
| - | - | - |
| 0.1 | Correct the `plans/README.md` status table and `docs/core/ROADMAP.md` (this change). **Done:** `bb657b5` (#188). | Planning docs claimed 15 landed plans were TODO. |
| 0.2 | Rename the OpenCAE leftovers in `CLAUDE.md`/`AGENTS.md` (`@opencae/*` filters, `apps/opencae-*` paths, the stale test count) and `docs/core/PROJECT_BRIEF.md` (WebGPU-first mission). **Done:** `4b7ba1c` (#190), `8ba692b` (#194). | The CI command block in `CLAUDE.md` fails as written. Agents follow it. |
| 0.3 | Delete the unreachable `BoundaryConditionMenu` "Coming soon" entries, or wire them when R1 ships them. **Done:** deleted, `d020bba` (#191). | Dead UI that advertises unbuilt features. |
| 0.4 | Remove the Run panel **Fidelity** select, or make the solver read it. No solve path consumes it, yet the report prints it. **Done:** removed, `3d1e8fb` (#191). | A setting with no effect, printed on a report, is a truthfulness defect. |
| 0.5 | Route thermal through a bounded DOF helper like `boundedStructuralMaxDofs`. Callers can currently raise `DEFAULT_THERMAL_MAX_DOFS`. Remove the stale "dynamic solver does not enforce maxDofs" comment (`solve-pipeline/src/index.ts:616`). **Done:** `c3f6042` (#191). | Close the last uncapped public entry point. |
| 0.6 | Finish plan 010 (drop the `as Study` cast) and plan 012 (off-axis load gate, analytical ~604 Hz first-bending gate). **Done:** `966fa0e` (#192). | Close the remaining open accuracy gates. |
| 0.7 | ~~Fix the status-bar Feedback URL.~~ Closed: the maintainer kept the current `opencae-feedback` form. | No change. |
| 0.8 | Add `verify-wasm-mesh-browser` and `verify-offline-pwa` to the CI browser job, or record why they stay manual. Delete or wire the orphaned `trusted-ci.yml`. **CI change; review.** **Done:** both proofs run in the `browser-proof` job (`568913a`); `trusted-ci.yml` deleted (`032ba58`); #194. | Offline meshing is a headline feature with no CI gate. |
| 0.9 (M) | Plan 024 Release 3B: delete `apps/openfea-api`, the API-only services, `libs/openfea-db`, `-jobs`, `-storage` and `runners/openfea-runner-local`. Split browser-safe samples out of `db` first. **Deletes ~4.5k lines; review.** **Done:** `88b5975` (#193). | Removes a second code path before new schemas multiply it. |
| 0.10 | Adopt `packages/viewer` during the R1 viewer extraction, or delete it. **Done (deleted):** parity tests (`apps/openfea-web/src/components/solverSurfaceRenderParity.test.ts`) showed the app reproduces every viewer buffer (positions, indices, nodeMap, values, min/max, displacement vectors) for Tet4/Tet10 in m and mm, and adds normals, colours, deformation and non-stress contours. The viewer's output is frozen as a fixture. The pinned `fleet-ci.yml` still runs `pnpm --filter @openfea/viewer build` (matches nothing, exits 0) until its next re-pin. | It is built and tested in CI but nothing imports it. |
| 0.11 (M) | Add lint: ESLint flat config with `typescript-eslint`, starting with `no-floating-promises`, `no-misused-promises` and `eqeqeq`, then a CI step. **New dev dependencies; flag.** **Done:** `76653ba`, `ed3ad4f` (#195). | Async UI and solver orchestration have no static guard today. |

### R1 — Model the real part (next; highest product leverage)

Engineers lose time at setup, not at the solver. Every item here reuses
solver capability that already exists.

| # | Item | Effort | Method and gate |
| - | - | - | - |
| 1.1 | Extract the selection, overlay and pick seams from `CadViewer.tsx`, and run and persistence orchestration from `WorkspaceApp.tsx` (plan 024 5B). | L | No behavior change. Characterization and browser checks before each extraction. This is the prerequisite for 1.2 and R3. |
| 1.2 | Direct multi-pick (ctrl/cmd-click to add and remove faces) plus a named-selection manager: create, rename, reuse in several BCs. **Done** (#225): Ctrl/Cmd-click and a keyboard face list feed the Additional faces model; the manager saves `selection-named-*` face sets with B-rep face IDs and a `faceset:v1` fingerprint, renames them, deletes unused ones, and lets several supports/loads reference one; the pick/selection seam moved out of `CadViewer.tsx` into `components/viewer/selection.ts` (the 1.1 slice this needed). The adapter maps a multi-face selection by B-rep face identity before the plane heuristic. | M | Selections persist B-rep face IDs and fingerprints. `verify:step-selection-browser` extends to multi-pick at both display LODs. |
| 1.3 | Per-body materials (second half of decision 030A). **Done:** `27722d0`, `4edeae6` (#203). | M | The solver already supports a material per element block. Map mesh-intake body IDs to blocks and add one report row per body. Gate: a two-material bar in series matches the closed-form series-spring deflection. Old single-material projects round-trip unchanged. |
| 1.4 | Per-component fixed supports and symmetry/roller supports. | M | v1 accepts faces whose normal lies within a named angular tolerance of a global axis and constrains that component. It rejects other faces with an explicit error. Gate: a half-model and a quarter-model of the cantilever match the full-model deflection and stress. |
| 1.5 | Elastic (foundation) support: normal and/or tangential stiffness per area, in N/m³. | M | Add the consistent face matrix k∫NᵀN dA, which is SPD and removes rigid-body modes. Gate: a block on an elastic foundation matches F/(kA). Unit-equivalence test. |
| 1.6 | Bearing load on a cylindrical face. | S–M | Cosine-weighted projected-area distribution over the loaded half. Gate: the resultant equals F exactly and the moment about the axis is zero within tolerance. |
| 1.7 | Local coordinate systems: cylindrical and face-aligned, for loads, prescribed displacement and supports. | M | Use robust frame construction (degeneracy and handedness checks), persisted with the study. This also unlocks skew symmetry in 1.4 v2 through the nodal transformation method. |
| 1.8 | Remote displacement and rigid coupling (RBE2-style). | L | Use master–slave MPC elimination, not penalty, to keep CG conditioning. Report coupling reactions. Gate: a rigid-link cantilever matches the beam solution. |

### R2 — Mesh control and quality (next, parallel with R1)

| # | Item | Effort | Method and gate |
| - | - | - | - |
| 2.1 | Show mesh quality: scaled Jacobian or SICN and aspect-ratio histograms, worst-element highlight, and Tet10 det J > 0 at quadrature points (curved meshes). **Done:** `9b3a3fd`, `f15ea2b` (#198). | S–M | Computed in a worker from the existing volume mesh. Labeled thresholds. Shown in the Mesh panel and the report. |
| 2.2 | Local sizing per face or edge, persisted by B-rep face ID. **Done (#227):** faces only (the STEP registry has no B-rep edge ids); `meshSettings.localSizing` stores face id + fingerprint + size in mm; Mesh panel add/edit/remove in project units; pre-mesh estimate and DOF preflight. | M | Gmsh Distance + Threshold size fields. The DOF preflight runs before the mesh. Gate: the plate-with-hole Kt error improves at equal total DOF. Measured on this branch (thickness-averaged hole-edge hoop stress vs Kt_net = 2.422): uniform 3.8 mm, 25,920 DOF, Kt 2.347 (3.1% error); 1 mm on the hole wall under 6 mm, 26,310 DOF, Kt 2.464 (1.7%). mm vs m and estimate-band gates pass; browser proof: see `docs/validation/README.md`. |
| 2.3 | Element error indicator: Zienkiewicz–Zhu recovered-stress energy-norm indicator per element. | M | Labeled an *indicator*, not an error bound. Feeds 2.4. Gate: on the plate-with-hole, the indicator ranks the hole-edge elements highest. |
| 2.4 | Adaptive refinement loop: indicator → size field → remesh, two or three passes, under the DOF cap. | L | Reuses the convergence-ladder UI. Each pass is reported. It must not replace the working mesh without confirmation. |

### R3 — Results that answer the question (next)

| # | Item | Effort | Method and gate |
| - | - | - | - |
| 3.1 | Modal mass participation and cumulative effective mass per direction. **Done:** `cc90be1` (#196). | S | Γᵢ = φᵢᵀMr with mass-normalized φ. Report the projected-model caveat when the Tet10 → Tet4 projection applied. Gate: the sum approaches the total mass as the number of modes grows on a free-free bar. Prerequisite for harmonic (R6). |
| 3.2 | Path plots and linearized stress (membrane + bending along a stress classification line). | M | Interpolate with the existing probe evaluation. Integrate along the path with a stated quadrature. Gate: pure tension and pure bending of a block recover the closed-form membrane and bending values. |
| 3.3 | Run and study comparison: a KPI table across studies, and a difference field only when two results share topology. | M | No cross-mesh interpolated differences in v1, to avoid hidden mapping error. |
| 3.4 | Safety factor basis choice: yield or ultimate, plus a user allowable, stated in the legend and report. **Done** (#223): per-study `safetyFactorBasis`, re-scaled from the stored yield-basis result without re-solving; ultimate offered only for a material with an ultimate strength (no catalog entry has one) and only for single-material models. | S | Default unchanged (yield over von Mises). |
| 3.5 | Report preview and offscreen figure capture (plan 028 D15/S7). | M | Removes the dependence on viewer state during report capture. |
| 3.6 | Parametric design sweep: one parametric-part dimension × N values → batch mesh and solve → KPI curves. | L | Each point respects the DOF cap and cancellation, and every point keeps its own provenance. |

### R4 — Physics breadth on existing solvers (later; needs decisions D1–D3)

| # | Item | Effort | Method and gate |
| - | - | - | - |
| 4.1 | Thermal convection (Robin) BC, h(T − T∞). This is option A of decision 033. | M | Add h∫NᵀN dA to K and h T∞∫N dA to the RHS; K stays SPD. Imperial display for h. Energy balance includes convected heat. Gate: closed-form slab and fin solutions. |
| 4.2 | Linear eigenvalue buckling. This is option A of decision 032 and plan 024 Release 7. | L | Geometric stiffness from the static preload. Solve the largest μ of K⁻¹(−K_G) with the existing subspace machinery, so the shift-invert stays on SPD K; λ = 1/μ. Label it a bifurcation load factor. Gate: Euler column in three orientations, load-scaling reciprocity, tension preload gives no positive factor. |
| 4.3 | One-way thermal stress: thermal result → thermal strain load in a static study. | M–L | Needs CTE and reference temperature data per material, with each source stated. Load vector ∫BᵀDε_th dV. Gate: a free bar gives zero stress and αΔTL expansion; a clamped bar gives −EαΔT. **This conflicts with decision 033's "no coupling"; see D3.** |
| 4.4 | Transient thermal conduction. | L | θ-method (backward Euler default) with lumped capacitance, reusing the dynamic frame machinery. Gate: lumped-capacitance decay and the semi-infinite-solid erf solution. |

### R5 — Scale and performance (later; evidence first)

| # | Item | Effort | Method and gate |
| - | - | - | - |
| 5.1 | Browser benchmark ladder at about 30k, 75k and 150k DOF in Chromium and WebKit: assembly time, solve time, iterations, peak memory, residual. Publish the envelope in `docs/validation/`. **Partial:** Chromium envelope published in `docs/validation/solve-ladder.md` (`4f9541b`, #197). WebKit not run; the proposed CI smoke rung is not wired. | M | Plan 024 Release 4. The 150k ceiling is benchmarked in Chromium only. Say so wherever the ceiling is quoted. |
| 5.2 | Evaluate SSOR as the inner preconditioner for modal and dynamic, which use Jacobi today. | S–M | Switch only on a consistent win with numerical parity. Record the choice in diagnostics. |
| 5.3 | GPU-resident CG: vectors, reductions and convergence checks on WebGPU. Then re-enable automatic Tet4 routing above the CPU envelope. | XL | Float32 dot products need compensated or mixed-precision reduction and parity against the CPU path at the relative tolerance. The ceiling is raised per device class, from 5.1 data. |
| 5.4 | IC(0) only if 5.1/5.2 miss the target. | M | Positive-pivot checks and a deterministic fallback, per plan 024. |

### R6 — Dynamics and contact breadth (later)

| # | Item | Effort | Method and gate |
| - | - | - | - |
| 6.1 | Harmonic response by modal superposition (plan 024 Release 6). | L | Needs 3.1. Truncation warning when the sweep passes the retained modal coverage. Gate: damped SDOF and 2-DOF systems, and the static limit. |
| 6.2 | Unilateral frictionless contact with an active set, allowing separation and re-closure, small sliding (docs/core Phase 11). | XL | Outer active-set loop on the existing node-to-surface pairs, with a cycle guard and convergence diagnostics. Gate: two-block gap closure, a lift-off case and a flat punch. It replaces "initially closed" only once those pass. |
| 6.3 | Transversely isotropic material for AM parts, using the build direction already in print settings, as an opt-in alternative to the homogenized isotropic factors. | L | Per-element material frame. Gate: rotated-frame invariance and uniaxial tests along and across layers. A Tsai–Hill-type safety factor must be labeled. |

### R7 — Structural elements (later)

Plan 024 Release 8 is kept as written: generalize to 6-DOF nodes, then a
triangular DKT shell, then a 2-node Timoshenko beam, each a separate release
with patch and closed-form gates. Start only after R1 to R3, because shells
need explicit midsurface workflows that depend on the selection and viewer
seams from 1.1–1.2.

### Parked (not planned; revisit on user evidence)

- **STL/OBJ solving** (decision 031B stands). Revisit if feedback shows mesh
  users.
- **Full-transient export archive** (decision 034B stands).
- **IGES import.** `occt-import-js` reads IGES, but face identity,
  fingerprints and exact-source export are STEP-specific. Scope it only with a
  plan for selection persistence.
- **Nonlinear material, large deformation, friction, fatigue.** These are
  outside a linear preview. Fatigue needs material S–N data the product does
  not have.
- **Accounts, share links, collaboration.** They conflict with local-first.
  The portable project file and HTML viewer remain the sharing story.
- **i18n.** No demand recorded.

### Unscheduled findings (not releases)

Defects found by the R5.1 ladder (`docs/validation/solve-ladder.md`). They
are tracked here until they get their own PRs; they are not new releases.

| # | Finding | Status |
| - | - | - |
| U1 | CG reports `converged: true` from its recursive relative residual (1e-10), but on slender static models the true residual ‖Ku − f‖/‖f‖ is 1.9e-7 at 30k Tet4 and 1.1e-6 at 150k Tet10 (ladder finding 3). Answers stay physically sound, but the diagnostic overstates convergence. | Fixed on this branch (b89788a): CG recomputes the true residual, restarts up to two bounded cycles, gates `converged` on it and sets `partialConvergenceWarning` when it misses tolerance. |
| U2 | Slender modal at 30k DOF drops the near-degenerate first bending pair: it converges 1 of 3 requested modes (correctly labelled mode 3, with `partialConvergenceWarning`) after the 30-iteration subspace cap (ladder finding 4). | Open, unscheduled. Candidate fixes: more iterations or a larger block, a tighter inner solve, or SSOR (overlaps R5.2). |

## Decisions

The maintainer accepted D1–D5 as recommended on 2026-10-21 and kept the
current Feedback URL, which closes R0.7 with no change.

| # | Decision | Recommendation (accepted) |
| - | - | - |
| D1 | Reopen decision 033 for convection only (4.1)? | Yes. It is the most common thermal BC, small, and keeps K SPD. Transient thermal (4.4) stays behind it. |
| D2 | Reopen decision 032 for buckling before harmonic? | Yes, buckling first. Thin brackets under compression are a real failure mode for the parts users import. Harmonic waits for mass participation (3.1). |
| D3 | Allow one-way thermal stress (4.3), even though decision 033 says thermo-mechanical coupling is out? | Allow it as a one-way sequential load. That does not need a coupled solver. Requires sourced CTE data for the 22 materials. |
| D4 | Delete the reference backend now (0.9) or keep it as a teaching reference? | Delete. Production does not use it and it doubles the surface every schema change touches. |
| D5 | Lint tool: ESLint + `typescript-eslint` or Biome? | ESLint. Only `typescript-eslint` offers the type-aware promise rules. |

## Order

1. R0 in any order. 0.2 and 0.4 first because they are truthfulness fixes.
2. 1.1, then 1.2–1.4 alongside 2.1–2.2 and 3.1.
3. 1.5–1.8, 2.3, 3.2–3.5.
4. R4 per D1–D3, with 5.1 in parallel.
5. 2.4, 3.6, R5 remainder, R6.
6. R7.

## Definition of done for this plan

Each item closes when its gate passes in CI, the user guide and validation
docs state its limits, and `plans/README.md` records it as done with its PR.
