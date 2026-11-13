# File Format

OpenFEA local project files use JSON and are saved with `.openfea.json` by default.

```json
{
  "format": "openfea-local-project",
  "version": 2,
  "savedAt": "2026-05-02T00:00:00.000Z",
  "project": {},
  "displayModel": {},
  "results": {}
}
```

- `project` contains schema-versioned project metadata, geometry file records, studies, loads, supports, mesh settings, and run references.
- `displayModel` contains the browser display representation, face references, optional visual mesh data, and optional native CAD metadata.
- `results` is optional and stores the active/completed run id, a structural, modal, or steady-state thermal result summary and result fields for completed local files.

Static and dynamic structural studies may contain `loadCases` and `loadCombinations`. Each load id appears in exactly one case. Cases do not contain their own supports, material, geometry, mesh, or solver settings. Combination factors are finite signed numbers that reference static case ids directly; nested combinations are not valid. Readers synthesize one enabled `Default` case containing every load when those arrays are absent in an older project.

Structural `results` may include `variants`, lightweight `variantRefs`, and `activeVariantId`. Variant kinds are `case`, `combination`, and `envelope`; dynamic case refs can be marked `persistedSeparately` because their full transient fields live in per-case IndexedDB records. An envelope may store compact `governingVariantIndices` with one shared variant-id table plus integer stress and displacement arrays. Older single-summary/field structural bundles reopen as one Default case variant. Modal bundles remain modal and are not rewritten as load cases.

Uploaded STEP, STP, STL, and OBJ source data can be embedded into the project metadata as base64 when the browser has the uploaded model content available. This makes saved local project files self-contained for reopening in the web app.

`project.customMaterials` is optional. Each entry uses a UUID id, name, category, Young's modulus and yield strength in Pa, density in kg/m³, Poisson ratio, optional thermal conductivity in `W/(m·K)`, optional copied additive `printProfile`, and `verification: "user_supplied_unverified"`. These definitions are project-scoped; there is no global browser material library. Because this is an optional backward-readable field, the outer container remains version 2.

Each study's `materialAssignments` entry may carry an optional `bodyId` (per-body materials, plan 036 R1.3). It names a viewer body, `step-object-<n>` for the n-th solid of a STEP import. An assignment without `bodyId` is the whole-model material and covers every body that has no assignment of its own, so every older single-assignment project reads exactly as before. A mesh generated for a per-body study names each body's volume elements `body:<bodyId>` (one Core element block, element set, and volume physical group per body); touching bodies are meshed as separate volumes with a shared conformal interface instead of being fused, and overlapping bodies are rejected. A mesh stored without body identity cannot carry different per-body materials and must be regenerated. This optional field does not change the container version.

Each study's `namedSelections` may hold user-managed named selections (plan 036 R1.2) next to the automatic one-face selections (`selection-<faceId>`). A managed selection is an ordinary `NamedSelection` entry with an id that starts with `selection-named-`, the user's name, `entityType: "face"`, one `geometryRefs` entry per face (the B-rep face ID, `step-face-<n>`, for STEP imports) and a `fingerprint` of the form `faceset:v1:` followed by a JSON array of each face's own fingerprint in `geometryRefs` order (the STEP registry's `stepface:a=…|c=…|n=…` digest when the face registry was live, otherwise the face's per-face selection fingerprint). Supports and loads reuse one by naming its id as `selectionRef`; readers resolve it over every face in `geometryRefs`, the same union `selectionRef` + `selectionRefs` already gets. The schema shape is unchanged, older projects have no managed selections and read exactly as before, and the container stays version 2. A backward-reading fixture is at `apps/openfea-web/src/fixtures/named-selection-project-v2.json`.

Custom materials may also carry an optional `ultimateStrength` in Pa (plan 036 R3.4). No starter catalog material has one.

Static and dynamic structural studies may carry an optional `safetyFactorBasis` (plan 036 R3.4): `{ "strength": "yield" | "ultimate" | "allowable", "allowableStress"?: number }`, with `allowableStress` in Pa and required when `strength` is `"allowable"`. It names what the displayed, reported and exported safety factor divides by; the stored result fields and summary always stay on the solver's yield basis and are re-scaled on read, so the basis never invalidates saved results. A study without the field, which is every study saved before it existed, reads as `yield`, and an unreadable value also reads as absent instead of rejecting the project. The outer container remains version 2.

`project.convergenceRecords` is also optional. Each static-case record stores its study/case ids, probe point and source, completion timestamps, classification, last-step percentage changes, and exactly three `coarse`, `medium`, and `fine` rung summaries. Rungs contain actual mesh/DOF counts and size when available, raw element peak von Mises stress, probe displacement magnitude, status, and an optional skip/failure reason. Solver meshes, surface fields, and result bundles are deliberately excluded. These compact records persist through workspace autosave and the same version-2 portable container.

`study.meshSettings.summary.qualityMetrics` is optional (plan 036 R2.1). It is a display-only element-quality summary of the solved volume mesh, written by the in-browser mesher: `version: 1`, the element type and count, the number of zero-volume elements, per-metric statistics (`worst`, `p5` measured from the bad side, `median`, and a fixed-range histogram of at most 256 bins) for the scaled Jacobian, radius-ratio aspect ratio `R/(3r)`, minimum and maximum dihedral angle in degrees and, for Tet10 meshes, the ratio of the minimum Gauss-point det J to the largest |det J|; element counts past each warning threshold; the thresholds used; and up to 256 worst element indices in mesh order. All metrics are dimensionless or in degrees, so they do not depend on `solverUnits`. Per-element arrays are never stored. Readers ignore an unreadable summary instead of rejecting the project, older projects without it load unchanged, and the outer container remains version 2. Imported project files drop it together with the mesh they describe.

`study.meshSettings.localSizing` is optional (plan 036 R2.2). It holds at most 64 local element sizes, one per STEP B-rep face: `id`, `faceId` (the face registry id, `step-face-<k>`), `fingerprint` (the registry's quantized area/centroid/normal digest, `stepface:a=…|c=…|n=…`; empty when the registry was unavailable, which resolves by face id alone), an optional display `label`, and `sizeMm`, a positive element size in STEP model space. OpenCASCADE imports STEP in millimetres, so `sizeMm` is millimetres regardless of the project's display units (US projects show and type inches). Before meshing, a rule binds to the face whose id carries its fingerprint, or within 5% area and 1% of the model diagonal of it; if the ids were renumbered, to the one face with the same fingerprint. A rule that matches neither is reported in the mesh warnings and not applied. The mesher turns each rule into a gmsh Distance + Threshold size field that grows from `sizeMm` on the face to the preset size at distance (preset − local) / 0.5. Discarding a mesh (geometry migration, imported-mesh discard, editing connections or local sizes) keeps the rules. An unreadable list is dropped instead of failing the project load; older projects without the field load unchanged, and the outer container remains version 2. A generated summary may also record `summary.density.localSizing` (`requested`, `applied` rule/face/size entries, and the pre-mesh `estimatedDofs` and `estimatedElements`); it is diagnostic only.

The open-section clipping plane is not part of this file format. Its enabled state, X/Y/Z axis, normalized offset, and flip direction are browser workspace UI preferences only.

## OpenFEA Core model schema 0.4.0

Core readers accept `0.1.0`, `0.2.0`, `0.3.0`, and `0.4.0`. Schema `0.3.0` adds a `modal` step with `boundaryConditions` and `modeCount` (1–10). Modal steps use material density and supports but no load references.

Schema `0.3.0` also adds four mesh-native load records. Values are always stored in the model coordinate system's canonical force units:

- `surfaceTraction` references a `surfaceSet` and stores a three-component `traction` force-density vector in Pa (`N/m^2`) for `m-N-s-Pa` models or MPa (`N/mm^2`) for `mm-N-s-MPa` models.
- `bodyForceDensity` references an explicit `elementSet` and stores a three-component `forceDensity` vector in `N/m^3` or `N/mm^3`.
- `remoteForce` references a `surfaceSet` and stores `totalForce` plus explicit `remotePoint` coordinates. It represents an equivalent distributed force and moment, not a rigid multipoint coupling.
- `equivalentBoltPreload` references two surface sets and stores a unitless direction vector `axis` plus positive `preloadForce`. It is static-only and represents equal/opposite bonded-linear tractions without contact, slip, or fastener stiffness.

The project-level load discriminators are `surface_traction`, `volume_force`, `remote_force`, and `bolt_preload`. Remote points and bolt secondary-selection references live in each load's optional parameter metadata. These optional records do not change the outer project-container version.

Modal result bundles are discriminated by `summary.analysisType: "modal_analysis"`. Each mode records its 1-based index, frequency in Hz, eigenvalue, scaled residual, and field id. Its `mode_shape` field is a node-located 3-vector surface field with `normalized` units; it is never labeled as displacement. Shape vectors are normalized to a maximum nodal vector magnitude of 1 and have deterministic, physically arbitrary sign.

Any result-summary diagnostic may carry an optional `meshProjection` object: `sourceElementOrder` and `solveElementOrder` (`"Tet4"` or `"Tet10"`), unitless integer `sourceDofs` and `solveDofs`, and a `reason` string. A local modal solve of a quadratic mesh above 50,000 DOFs runs on its corner-node Tet4 projection; its summary then stores one `modal-mesh-projection` warning diagnostic whose message is the report line ("Mesh projection for solve: Tet10 → Tet4 (local-modal-performance). Results are computed on the projected mesh.") and whose `meshProjection` is `{ sourceElementOrder: "Tet10", solveElementOrder: "Tet4", sourceDofs, solveDofs, reason: "local-modal-performance" }`. The result provenance tier is unchanged. Modal results saved before the payload existed omit it (a diagnostic carrying only the message still reports the line, and `massParticipation.computedOnProjectedModel` still marks the projection) and load unchanged; an unreadable `meshProjection` is dropped instead of rejecting the results. The outer container remains version 2.

Schema `0.4.0` adds steady-state conduction and solved assembly connections:

- `isotropicLinearElastic` materials may carry `thermalConductivity`. It is `W/(m·K)` in `m-N-s-Pa` models and `W/(mm·K)` in `mm-N-s-MPa` models; adapters convert catalog values explicitly.
- `prescribedTemperature` fixes a node or surface set in degrees Celsius. `surfaceHeatFlux` is positive heat entering a surface in `W/m²` or `W/mm²`. `volumetricHeatGeneration` is positive internally generated heat in `W/m³` or `W/mm³`.
- `steadyStateThermal` references the temperature boundary conditions and heat loads. Thermal results report Celsius temperatures, heat-flux vectors, and relative energy-balance error.
- `meshConnections` records `fuse`, `tie`, or `contact`. Tie and contact reference source/target surface sets and may provide positive search tolerance and penalty scale. Contact is `frictionless` and `small_sliding`.

The schema 0.4 contact implementation is a linearized initially closed normal penalty. It does not encode separation/re-closure, friction, or large-sliding state history.

The outer `openfea-local-project` container remains version 2 because the new study and result shapes are backward-readable additions. Legacy structural summary/field bundles continue parsing as one Default run variant.

## Self-contained result viewer

The `.html` result export is a separate, standalone artifact rather than a project container. It embeds one `openfea-result-viewer` version-1 payload containing the display metadata, solved surface mesh, summary, fields, and provenance. Structural payloads may add an optional `safetyFactorBasis` label (for example `"yield, von Mises"`); the payload's summary and safety-factor fields are already re-scaled to that basis. The file uses inline CSS/JavaScript and makes no server or network requests.

## Selected-state raw result exports

CSV and VTK XML UnstructuredGrid (`.vtu`) exports use `openfea_export_schema_version` 1.0.0. Both formats contain one active result variant and one selected static state, dynamic frame, modal mode, or harmonic frequency. They preserve canonical field values (safety-factor fields re-scaled to the study's basis, named in a `safety_factor_basis` metadata row when one is exported) and explicitly record the right-handed Z-up coordinate system, length units, per-field units/components/locations, variant identity, and state identity.

CSV is a mixed node/element table with stable one-based source identifiers and canonical connectivity. Field column headers encode field id, type, location, component, and units. VTU stores Tet4/Tet10 volume cells using VTK cell types 10/24. Its `OpenFEA.Metadata.UTF8` `UInt8` FieldData array is UTF-8 JSON containing the export metadata and field catalog. Solver-surface nodal fields are mapped through the retained volume-node map; volume-interior tuples are `NaN`, never extrapolated. Export is chunked and has a 128 MB estimated browser-memory ceiling.
