# OpenFEA Architecture

OpenFEA's production workflow runs in the browser. There is no separate API server; the Cloudflare Worker serves the app and a small set of non-solve routes.

## Production path

- The React/Vite web app owns CAD import and analytic part creation, study setup, meshing, solving, local project save/open, result visualization, and reports.
- Browser workers run geometry/mesh and OpenFEA Core solve jobs. localStorage and IndexedDB persist workspace state and completed results; portable project files embed geometry and saved results.
- The service worker caches app and analysis assets. The app reports offline readiness only after installation completes.
- The Cloudflare Worker serves static assets, health routes, consent-gated client-encrypted recovery backups, and the Glimpse analytics relay. It stores no plaintext project snapshot or decryption key. Aggregate backend metrics and optional browser analytics follow the controls in [Glimpse integration](../glimpse.md).
- `pnpm build:cloudflare` builds Core and the web app. Core packages resolve from this repo's emitted `packages/*/dist` exports.

CAD entities remain the source of truth. Mesh entities are generated artifacts. Results and reports are immutable study-run artifacts. Loads, supports, contacts, and named selections bind to CAD topology references.

## Solver Boundaries

Static, dynamic, and modal structural studies run through OpenFEA Core with explicit attribution. `BROWSER_SOLVE_LIMITS.maxDofs` is the code authority for the guarded product ceiling, currently 150,000 DOF, and is passed by `@openfea/solve-pipeline` into every solver call. The cross-browser scale benchmark exercises approximately 100,000 DOF; it is a validation checkpoint, not performance certification of the 150,000-DOF ceiling. Simple block or beam-like studies may use a structured proxy mesh and are labeled preview-only. Complex geometry is blocked from that path unless an actual connected Core volume mesh artifact is available, in which case the result can carry actual-volume-mesh FEA provenance.

Dynamic and modal analysis share sparse stiffness, constraint reduction, and positive HRZ lumped-mass assembly. Modal analysis uses deterministic block shift-invert subspace iteration and returns only modes that satisfy the scaled residual tolerance. Its normalized vector fields use the same deformation renderer as displacement, while the web app creates 24 phase frames without storing duplicate solver output.

## Run Variants And Linear Reuse

Structural load cases own only load membership. Geometry, supports, material, mesh, and solver settings remain on the study, so every case necessarily shares the same constrained system. Static case batches assemble and reduce `K` once, then use the preceding converged displacement as the next CG initial guess. Signed combinations superpose displacement, reaction, strain, and six-component stress tensors; von Mises and principal stress measures are recomputed afterward from the combined tensor.

Static envelopes keep pointwise maximum von Mises, the displacement vector from the variant with the largest nodal magnitude, and compact integer arrays that map each surface node to its governing case or combination. Run and variant ids both participate in field-selection, probe-topology, and packed-playback identities.

Dynamic cases reuse one K/M preparation and Rayleigh calibration but start each transient solve from independent zero displacement, velocity, and acceleration. The solve worker posts each completed case immediately. The web app writes each transient case to a separate IndexedDB record and retains only the active case payload in memory; cancellation or batch failure removes partial records.

## Static Mesh Convergence

Static convergence studies are project records, not run variants. The browser clones one selected load case and executes `coarse -> medium -> fine` through isolated mesh and solve jobs, leaving the working study's mesh and active results unchanged. Each generated mesh is preflighted through the Core adapter for actual node, element, total-DOF, and free-DOF counts before solving. The current 150,000-DOF guarded product ceiling is imported from the lightweight `@openfea/solve-pipeline/limits` entry point and an over-limit rung is persisted as skipped instead of entering the worker.

The orchestrator retains only compact rung metrics: requested preset, actual mesh size and counts, raw element peak von Mises stress, and one interpolated displacement-probe magnitude. It reuses the result probe's barycentric vector interpolation on the nearest solver-surface triangle with a model-scale mapping tolerance. Full mesh and result fields remain transient to each worker job and are not attached to the convergence record.

## Advanced Load Assembly

All surface loads share one facet-integration boundary. Total face force, pressure, and surface traction are converted to a physical facet resultant and integrated with Tri3/Tri6-consistent nodal weights. Body force density is integrated over the selected element set using equal Tet4 weights or positive HRZ Tet10 lumping. Each path records the actual area or volume and assembled resultant so force conservation is observable at the solver boundary.

Remote force assembly treats the selected face as a distributed wrench. It solves the area-weighted minimum-norm nodal distribution subject to three resultant-force and three remote-point-moment constraints. Constraint rows are geometry-scaled before a pivoted 6x6 rank check; a degenerate selection fails instead of dropping moment equations. Diagnostics report requested and assembled force/moment plus their balance errors. The formulation does not create rigid MPC kinematics.

Equivalent bolt preload is a static load pair, not a contact model. Preflight requires two nonzero-area, separated, opposing surface sets on one connected structure and an axis aligned from the first centroid toward the second. Equal and opposite consistently distributed tractions must have zero net force and moment within scale-aware tolerance. The approximation omits contact, slip, and fastener stiffness and is labeled as such in UI and reports.

## Materials And Workspace Sections

Starter materials and optional project-scoped custom materials resolve through `@openfea/materials`. The same strict resolver is used by UI assignment, study validation, mesh intake, the browser Core adapter, and reports. An explicit dangling material ID is an error; no solver boundary substitutes a default material. Custom values are stored canonically in Pa and kg/m³, are marked user-supplied/unverified, and remain local to the owning project.

The open-section plane belongs to workspace UI state rather than the project model. Three.js local clipping is applied only below explicit geometry roots, including mesh/result materials and line-based feature/undeformed edges. Boundary-condition glyphs, probes, dimensions, and labels are separate scene branches and are not clipped. The WebGL `Open section` label is therefore present in viewer captures without becoming portable project data.
