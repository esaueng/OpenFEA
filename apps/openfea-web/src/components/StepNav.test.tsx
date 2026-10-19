import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Project, Study } from "@openfea/schema";
import { StepNav } from "./StepNav";
import { ProjectMenu } from "./ProjectMenu";

const project: Project = {
  id: "project-1",
  name: "Stepper",
  schemaVersion: "0.1.0",
  unitSystem: "SI",
  geometryFiles: [],
  studies: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

const study: Study = {
  id: "study-1",
  projectId: "project-1",
  name: "Static Stress",
  type: "static_stress",
  geometryScope: [],
  materialAssignments: [],
  namedSelections: [],
  contacts: [],
  constraints: [],
  loads: [],
  meshSettings: { preset: "medium", status: "not_started" },
  solverSettings: {},
  validation: [],
  runs: []
};

const baseProps = { activeStep: "model" as const, hasResults: false, onSelect: () => undefined };
const css = readFileSync(resolve(__dirname, "../styles/app.css"), "utf8").replace(/\r\n/g, "\n");

describe("StepNav", () => {
  test("renders the workflow as an ordered list of named steps with the current step marked", () => {
    const html = renderToStaticMarkup(<StepNav {...baseProps} activeStep="material" study={study} />);
    expect(html).toContain('<nav class="step-nav" aria-label="Simulation workflow"><ol class="step-nav-list">');
    const labels = [...html.matchAll(/class="step-nav-label">([^<]+)</g)].map((match) => match[1]);
    expect(labels).toEqual(["Model", "Material", "Supports", "Loads", "Mesh", "Run", "Results"]);
    expect(html).toMatch(/class="step-nav-step active"[^>]*aria-current="step"[^>]*>[\s\S]*?Material/);
    // Steps carry no number or tick: the label names the step and the bar under it
    // (a CSS pseudo-element keyed on the state class) shows progress.
    expect(html).toContain('<button type="button" class="step-nav-step done" title="Model"><span class="step-nav-label">Model</span></button>');
    expect(html).not.toContain("step-nav-glyph");
    expect(html).not.toContain("lucide-check");
  });

  test("drops the loads step for modal studies", () => {
    const html = renderToStaticMarkup(<StepNav {...baseProps} study={{ ...study, type: "modal_analysis", solverSettings: { modeCount: 6 } }} />);
    expect(html).not.toContain(">Loads<");
    expect(html.match(/class="step-nav-item"/g) ?? []).toHaveLength(6);
  });

  test("disables steps the study cannot reach yet", () => {
    const html = renderToStaticMarkup(<StepNav {...baseProps} study={study} />);
    // Run needs a completed mesh before it can be opened (canNavigateToStep).
    expect(html).toMatch(/<button type="button" class="step-nav-step" disabled=""[^>]*title="Run"/);
    expect(html.match(/disabled=""/g) ?? []).toHaveLength(1);
    const meshed = renderToStaticMarkup(<StepNav {...baseProps} study={{ ...study, meshSettings: { preset: "medium", status: "complete" } }} />);
    expect(meshed).not.toContain('disabled=""');
  });

  test("does not render a report workflow step", () => {
    const html = renderToStaticMarkup(<StepNav {...baseProps} activeStep="results" study={study} />);
    expect(html).not.toContain("Report");
    expect(html).not.toContain("lucide-file-text");
  });

  test("names every step on hover, since narrow tiers show only the current label", () => {
    const html = renderToStaticMarkup(<StepNav {...baseProps} study={study} />);
    for (const label of ["Model", "Material", "Supports", "Loads", "Mesh", "Run", "Results"]) {
      expect(html).toContain(`title="${label}"`);
    }
  });
});

describe("stepper states from readiness (2026-09 review D14)", () => {
  test("shows a step as blocked, not done, when its readiness row has a blocker", () => {
    const blockedStudy = {
      ...study,
      loads: [{ id: "load-1", type: "force" as const, selectionRef: "face", parameters: { value: 500 }, status: "complete" as const }]
    };
    const html = renderToStaticMarkup(
      <StepNav {...baseProps} study={blockedStudy} readiness={[
        { label: "Load added", done: false, blockers: ["Load case Case 2 is enabled but has no loads. Add a load to it or disable it."] }
      ]} />
    );
    expect(html).toMatch(/class="step-nav-step blocked"[^>]*><span class="step-nav-label">Loads<\/span><svg[^>]*class="[^"]*step-nav-flag warning"/);
    expect(html).toContain("lucide-triangle-alert");
    expect(html).toContain('aria-label="Loads: Load case Case 2 is enabled but has no loads. Add a load to it or disable it."');
  });

  test("ticks Run and Results only for results the viewer can show", () => {
    const seeded = { ...study, runs: [{ id: "run-seeded", studyId: study.id, status: "complete", createdAt: "2026-01-01T00:00:00.000Z" }] } as unknown as typeof study;
    const html = renderToStaticMarkup(<StepNav {...baseProps} study={seeded} />);
    expect(html.match(/step-nav-step done/g) ?? []).toHaveLength(1); // model only
  });

  test("badges the step that carries the workspace notice", () => {
    const html = renderToStaticMarkup(<StepNav {...baseProps} study={study} notices={{ run: "error" }} />);
    expect(html).toMatch(/<span class="step-nav-label">Run<\/span><svg[^>]*class="[^"]*step-nav-flag error"/);
    expect(html).toContain('aria-label="Run: needs attention"');
    expect(html).toContain('title="Run: needs attention"');
  });
});

describe("ProjectMenu", () => {
  test("keeps theme and units one click away in the top bar", () => {
    const html = renderToStaticMarkup(
      <ProjectMenu themeMode="dark" unitSystem={project.unitSystem} onThemeModeChange={vi.fn()} onUnitSystemChange={vi.fn()} />
    );
    expect(html).toContain('aria-label="Project"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="workspace-project-menu"');
  });
});

describe("stepper CSS", () => {
  test("retires the left rail and its width token", () => {
    const tokens = readFileSync(resolve(__dirname, "../theme/tokens.css"), "utf8");
    expect(tokens).not.toContain("--stepbar-w");
    expect(css).not.toMatch(/\.stepbar\b/);
    expect(css).not.toContain("--stepbar-w");
    expect(css).toMatch(/^\.workspace \{[^}]*grid-template-columns:\s*minmax\(360px, 1fr\) var\(--context-w\);/m);
  });

  test("shows progress as a bar under each step name", () => {
    // Thickness as well as colour: a 1px track for a step still to do, 2px once done or current.
    expect(css).toMatch(/^\.step-nav-step::after \{[^}]*height:\s*1px;[^}]*background:\s*var\(--color-border-strong\);/m);
    expect(css).toMatch(/^\.step-nav-step\.done::after \{\s*height:\s*2px;\s*background:\s*var\(--color-success\);/m);
    expect(css).toMatch(/^\.step-nav-step\.active::after \{\s*height:\s*2px;\s*background:\s*var\(--color-accent\);/m);
    expect(css).toMatch(/^\.step-nav-step\.active \{[^}]*font-weight:\s*var\(--fw-semibold\);/m);
    // Every label fits the top bar down to 1181px; only below that do labels clip.
    expect(css).toMatch(/@media \(max-width: 1180px\) \{\s*\.step-nav-step:not\(\.active\) \{/);
    expect(css).not.toMatch(/\.step-nav-glyph|\.step-nav-dot|\.step-badge/);
  });

  test("hides inactive step labels visually, never from assistive tech", () => {
    // display:none would strip the accessible name; the narrow tiers clip instead.
    expect(css).not.toMatch(/\.step-nav-label[^{]*\{[^}]*display:\s*none/);
  });
});
