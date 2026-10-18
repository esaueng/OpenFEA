# 035 — Guided design overhaul

## Status

Proposed on 2026-10-18 against `origin/main` at `344818f9`. Nothing is
implemented; this branch carries only this document.

The direction was chosen from three mockups (Guided, Studio, Coach) on the
maintainer's private design canvas. The row "A · Guided" holds the four target boards: start screen,
Loads step, Results and report cover. The boards are static mockups. Treat
them as intent, not as pixel specs.

Earlier passes (plan 027 in Sept, the Sept 24 refinement, PRs #99 and
#131–#137) refined the existing identity. This plan changes the layout and the
voice. It keeps the token tier, Plex, the honest-results vocabulary, and the
dark canvas.

## Brief

- **Target user:** someone who is new to FEA, or who uses it now and then. A
  power user must not lose anything they have today. They may need one more
  click to reach advanced controls.
- **Feel:** modern and approachable, built on the Esau "Instrument" identity. That means
  IBM Plex Sans + Mono, the steel tokens, one accent, hairlines, and a canvas
  that never re-themes.
- **Scope:** the workspace shell, the viewer chrome, the start screen and the
  report PDF.

## What changes, in one sentence each

1. **Stepper in the top bar.** The 124 px left rail is replaced by a
   horizontal numbered stepper. The viewer gets the width back.
2. **One question per step.** Each panel is titled with the question the step
   answers ("Where does the force push?"). It shows the current answer, and
   advanced controls sit behind "More options".
3. **A floating view toolbar.** The `X Y Z Iso` strip, the projection toggle
   and the Model step's View block merge into one pill toolbar on the canvas.
4. **Results lead with the verdict.** The panel shows the verdict, four KPI
   numbers and one "Show on model" choice. Display tuning is folded away.
5. **Start screen without a second page.** Three action cards, an inline
   sample gallery with an analysis-type filter, and Recent.
6. **A quieter status bar.** It shows the status and a one-line study summary.
   Utility links move out.
7. **Report cover leads with the verdict.** The order is verdict, a KPI row,
   then a large figure.

## Deviations from the Esau system (accepted 2026-10-18)

| Esau rule | This plan | Why |
| - | - | - |
| `fs-base` 13px is the document default | Panel body text at `--fs-md` 14px; chrome stays at 13px | Approachability. A 14px step already exists in the tokens. |
| Uppercase `mono-eyebrow` labels sections | No uppercase eyebrows **inside panels**. Section labels use sentence-case 14px/500. Eyebrows stay in chrome and in the report. | Uppercase tracked mono reads as instrument output, not as a question. |
| `fs-xl` 22px is the ceiling in chrome | Kept. The panel question title is 22px. | — |

The maintainer accepted both on 2026-10-18. Amend the Esau README to match, or
the next Open\* app will copy the 13px panels. Increment 0 shipped as #166.

## Increments

Each increment is one PR on its own branch, cut from `main` or from the
previous increment's branch. Do not push increment N+1 onto the branch of
increment N (see the stacking trap below). Recommended merge order:
**0 → 1 → 2 → 3 → 4 → 5 → 6**. Increments 5 and 6 are independent of 1–4 and
can run in parallel sessions.

### 0 — Panel type and tokens (implemented in #166)

As built (this differs from the first draft of this section):

- `theme/tokens.css` gains a panel type tier: `--panel-fs-mini/xs/sm/base` =
  11/12/13/14px. These are plain values, not composed tokens, so they need no
  light-scope copy.
- `.side-panel` (the right panel; there is no `.context-panel`) remaps
  `--fs-mini..--fs-base` onto that tier and restates `font-size`. Every panel
  rule moves up one step, and the top bar, status bar, overlays and portalled
  popovers stay at 13px.
- `:where(.side-panel) button` keeps button labels at 13px. At 14px,
  "Show dimensions" wrapped in the two-up View grid.
- `.section-title`, `.editable-list h3`, `.panel-eyebrow` and the result KPI
  labels leave the uppercase mono eyebrow group. Their markup is now sentence
  case.
- Back/Next use `--control-h-touch`. The Direction and Show-on-model radios
  pick it up when increments 2 and 4 build them.
- The collapsible subtitle wraps instead of truncating at 390px.
- The question title at `--fs-xl` and the panel gap belong to increment 2.

### 1 — Horizontal stepper in the top bar

Today: `components/StepBar.tsx` (154 lines) renders a vertical `nav.stepbar`
inside `.workspace`. `styles/app.css` sets `.workspace` (around line 1945) to
`grid-template-columns: var(--stepbar-w) minmax(360px, 1fr) var(--context-w)`.
The rail footer holds the theme toggle, the study-type label and the unit
switch.

- Create `components/StepNav.tsx`, a horizontal `<nav aria-label="Simulation
  workflow"><ol>`. **Reuse StepBar's logic unchanged**:
  - `readinessBlockersByStep`
  - the `completed` record ("present and valid")
  - `canNavigateToStep`
  - `notices`
  - the modal-analysis filter that drops `loads`

  Each step is a button with a numbered dot. A done step shows a check. A
  blocked step shows the warning colour plus a glyph, never colour alone. The
  current step is filled with the accent and has `aria-current="step"`. Keep
  `title`/`aria-label` carrying the blocker text as today.
- Mount it in `.topbar` (`WorkspaceApp.tsx` around line 2587), centred
  between the breadcrumb and the tools. Move the rail-footer controls (theme,
  units) into a new top-bar **Project menu** (`⋯`, a focus-trapped popover
  following `ResultExportMenu`). The study-type label is already in the
  breadcrumb, so drop it there.
- Drop the `--stepbar-w` column. Retire the `stepbar-collapsed` shell class
  and its stored preference. Delete `StepBar.tsx` once `StepBar.test.tsx` is
  ported to `StepNav.test.tsx` (same cases: blocked, notice, modal filter,
  disabled before mesh).
- **Run button:** keep "Run simulation" at the right of the top bar. The
  mockup left it out for clarity, but it is the app's one global action and
  power users depend on it.
- **Below 980px:** the stepper collapses to a compact
  `Step 4 of 7 · Loads ▾` button that opens the same list. The ≤980px layout
  was hard won (trap 6). Re-measure the short-and-narrow case after the rail
  is gone.
- **Done when** all seven steps (six for modal) navigate, the blocked and
  notice states render, the viewer gains ~124px, and the 390px layout works.

### 2 — One question per step (panel IA)

`components/panels/PanelChrome.tsx` owns the header (`Step {n} of {N}`
eyebrow, line 83) and the footer (`Back: X` / `Next: X`, lines 143–144).

- **Header:** a small muted line `Step n of N · Label`, then an `h2` with the
  question, then one helper sentence. Add an optional `question` field to the
  per-step metadata next to `workflowStepsForStudy`.

  | Step | Question (static / thermal / modal variants where different) |
  | - | - |
  | Model | "Is this the right part?" |
  | Material | "What is it made of?" |
  | Supports | "Where is it held still?" |
  | Loads | "Where does the force push?" · thermal: "Where does heat go in or out?" |
  | Mesh | "How finely should it be divided?" |
  | Run | "Ready to solve?" |
  | Results | (the verdict replaces the question; see increment 4) |

- **Footer:** Back becomes a quiet text button. Next becomes the single
  primary button "Continue to {next}". Keep the B/N shortcuts and their
  `kbd` hints.
- **Loads panel** (`SupportsLoadsPanels.tsx`):
  - The selected face is shown as a chip with an "Add faces" link. The
    "Additional faces" checkbox list moves behind that link.
  - Direction becomes a 3-way radio. These are **display labels only**: the
    persisted `directionMode` values in `LOAD_DIRECTION_LABELS`
    (`loadPreview.ts:10`) do not change.
    - "Into face" = `Opposite normal`
    - "Away" = `Normal`
    - "Along axis" reveals the existing ±X/±Y/±Z select
  - Load type, load cases and the face-force explanation move into
    "More options".
  - Keep the coordinate-space rules: labels map through the same
    `directionVectorForLabel` call.
- **Model panel:** the Orientation block and the View buttons move to the
  viewer toolbar (increment 3). The panel keeps the study facts table.
- **Mesh panel:** the convergence tools stay in their `Collapsible`, which
  plan 027 B already made.
- **Done when** every panel answers its question above the fold at 1440×900,
  and each moved control is still reachable by keyboard.

### 3 — Viewer chrome

`CadViewer.tsx:524` renders `.viewer-view-presets` (`X Y Z Iso` plus the
Perspective/Orthographic buttons).

- Replace it with a bottom-centre floating `role="toolbar"` pill: Fit,
  Views ▾ (X/Y/Z/Iso and Perspective/Orthographic as menu items), Section,
  Mesh, Dimensions.
  - **Constraint:** the view cube is drawn in the canvas and cannot be reached
    by keyboard. The Views menu is the accessible camera control (this is why
    plan 027 C was withdrawn), so it must stay fully keyboard-operable with
    arrow-key menu semantics.
- Add an on-canvas **selection chip** for the active pick, for example
  `Top load face · 500 N into face`. It is DOM over the canvas, so use
  `--color-viewport-*` inks (Esau rule: chrome inks vanish under light chrome).
- Add a one-line orbit hint, bottom-left. Hide it after the first orbit (keep
  that flag in localStorage, wrapped in try/catch).
- The toolbar uses viewport tokens in both themes. Scene labels are WebGL and
  are themed separately in `sceneLabelColors` (trap 5).
- **Done when** `pnpm verify:step-selection-browser` passes. The toolbar sits
  over the pick surface, so picks must still map to the same B-rep face IDs.

### 4 — Results

- The results panel leads with the verdict: icon + 22px title + one sentence
  that names the material and its yield, for example "Peak stress is 151×
  below the yield strength of Aluminum 6061 (276 MPa)." Build that sentence
  from the same data as today's verdict card.
- 2×2 KPI grid with mono `tabular-nums` (it exists; restyle only).
- "Show on model": a 3-way radio (Stress / Displacement / Safety factor).
  Thermal and modal keep their own modes through the same component.
- "Display options" `Collapsible` holds the stress measure, the colour scale
  (auto/manual, continuous/bands) and the Max-stress explanation.
- A mesh and provenance line under the KPIs, for example "Mesh: 557 nodes,
  1,605 elements · solved on this device". **Provenance tiers must keep their
  labels.** A preview, estimate or benchmark result must never read as
  computed FEA (CLAUDE.md invariant).
- Footer: "Download report" (primary) + "Export data" (the existing
  `ResultExportMenu`).
- Legend: move it from the top-left card to a bottom-left horizontal card.
  The 154px legend floor is still open from Sept 24 and is coupled to resize
  scaling. Measure before changing it.
- The peak label (`legend-peak`, `CadViewer.tsx:6999`) becomes an on-canvas
  callout at the peak element where the position is known. Otherwise it stays
  in the legend.
- **Done when** static, dynamic, modal and thermal results all render the
  verdict, KPIs and modes. The Sept 12 interaction-review cases (stale-result
  labelling, reload provenance) must still pass.

### 5 — Start screen (independent of 1–4)

`components/StartScreen.tsx` (324 lines). The start screen is always dark and
renders outside `.app-shell`.

- Header: the mark, "OpenFEA" at `--fs-display`, and the line "See how a part
  bends and where it is stressed — right in your browser. Nothing leaves this
  device."
- Three action cards: **Try a sample** (primary fill), New study, Open a
  project file. Keep the N and O shortcuts.
- The inline Samples section replaces the second "sample menu" page. It has
  the analysis-type segmented control (Static stress / Dynamic / Modal /
  Thermal) and three cards with real thumbnails. Render the thumbnails
  offline at build time or reuse `SampleOptionCard` art. No runtime capture.
- Recent: the real list, or a dashed empty state ("Projects you save or open
  appear here.").
- Footer: "Runs locally in your browser" · "Built by Esau Engineering ·
  GitHub".
- **Done when** loading a sample goes straight from the start screen to the
  workspace in one click. Re-check under `vite dev` StrictMode (trap 4).

### 6 — Status bar and report cover (independent of 1–4)

- **Status bar** (`BottomPanel.tsx`): status dot, status text and a one-line
  summary ("1 support, 1 load"). On the right: Help · Logs · Feedback.
  - **Decision required:** where the Ko-fi link and GitHub go. The proposal is
    the Project menu plus the start-screen footer.
  - Tips moves under Help.
- **Report cover** (`report/reportPdf.ts`, `cover()` at line 51):
  - Order: brand line → title + one-line context (model · material · load) →
    verdict box (keep `verdictLine()` wording) → a 4-up KPI row with a rule
    above → the primary figure filling the rest → footer with mesh counts.
  - The `provenanceTier !== "production_fea"` callout stays and stays above
    the KPIs.
  - The `transient.peakDisplacement` unit trap applies: it shares `maxDisplacementUnits` and must be converted.
  - Render a QA PDF with `REPORT_PDF_QA_OUTPUT`. The maintainer checks the
    generated PDF personally.

## Light theme

The mockups show steel-dark only. Every increment ships both themes using the
Esau `steel-light` values already in `tokens.css`. Any new composed token is
re-declared in `.theme-light` (trap 2), and any new popover portals through
`themedPortalRoot` (trap 3).

## Traps (from earlier UI passes; read before editing CSS)

1. `appCss.test.ts` pins literal declarations. Its `cssRule()` helper matches
   the **first** selector occurrence, so moving a block above a pinned rule
   captures the wrong one. It also rejects literal spacing px; use `--sp-*`.
   Control heights must use the `--control-h-*` tokens (`resolvedControlPx`).
2. Composed custom properties resolve where they are declared. Re-declare them
   in `:root, .theme-light`.
3. The theme class lives on `.app-shell`, not on `body`. Portals must use
   `themedPortalRoot(anchor)`.
4. Under `vite dev`, StrictMode's simulated unmount once aborted start-screen
   actions (#131). If headless automation never reaches the workspace, check
   this first.
5. Scene labels and the view cube are WebGL. DOM contrast audits cannot see
   them.
6. At ≤980px wide and short heights, the side panel once collapsed to 1px. The
   fix is a min-content floor plus sticky chrome. `auto` does not work there.
7. The dev server needs fresh `packages/*/dist`. On 2026-10-18 the dist still
   had the pre-rename `@opencae/*` imports and every sample load crashed. Run
   `pnpm build:core` and then `rm -rf apps/openfea-web/node_modules/.vite`.
8. Stacking: `gh pr create` refuses a head branch that already has an open PR,
   and pushing increment N+1 onto N's branch folds it into N's PR. Start each
   increment on its own branch.
9. vitest does not typecheck. Run `pnpm typecheck` as well as the tests.

## Verification per increment

- The CI block in `CLAUDE.md`, in order. `verify:step-selection-browser` is
  mandatory for increments 1–3.
- A visual sweep: headless Chrome (playwright-core with the cached
  Chrome for Testing) walks the Bracket Demo through every step plus one solve
  at 1440×900 and 390×844, in both themes. Attach the before and after images
  to the PR.
- A contrast check on every new surface in both themes. Text must reach
  4.5:1; the selection chip and toolbar sit on `--color-viewport-bg`.

## Not in scope

The Studio and Coach directions, the run-history plan (review item 3.1),
solver or meshing behaviour, and new analysis types.
