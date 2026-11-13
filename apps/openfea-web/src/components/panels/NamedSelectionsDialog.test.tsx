import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { Study } from "@openfea/schema";
import { NamedSelectionsDialog, type NamedSelectionManagerActions } from "./NamedSelectionsDialog";

const faceSelection = (faceId: string, label: string): Study["namedSelections"][number] => ({
  id: `selection-${faceId}`,
  name: label,
  entityType: "face",
  geometryRefs: [{ bodyId: "body-uploaded", entityType: "face", entityId: faceId, label }],
  fingerprint: faceId
});

const study = {
  id: "study-1",
  projectId: "project-1",
  name: "Static",
  type: "static_stress",
  geometryScope: [],
  materialAssignments: [],
  namedSelections: [
    faceSelection("step-face-1", "Face F1"),
    faceSelection("step-face-2", "Face F2"),
    {
      id: "selection-named-used",
      name: "Bolt holes",
      entityType: "face",
      geometryRefs: [faceSelection("step-face-1", "Face F1").geometryRefs[0]!, faceSelection("step-face-2", "Face F2").geometryRefs[0]!],
      fingerprint: 'faceset:v1:["a","b"]'
    },
    {
      id: "selection-named-spare",
      name: "Spare",
      entityType: "face",
      geometryRefs: [faceSelection("step-face-2", "Face F2").geometryRefs[0]!],
      fingerprint: 'faceset:v1:["b"]'
    }
  ],
  contacts: [],
  constraints: [{ id: "c1", type: "fixed", selectionRef: "selection-named-used", parameters: { label: "FS 1" }, status: "complete" }],
  loads: [],
  meshSettings: { preset: "medium", status: "not_started" },
  solverSettings: {},
  validation: [],
  runs: []
} as Study;

function manager(overrides: Partial<NamedSelectionManagerActions> = {}): NamedSelectionManagerActions {
  return { selectedFaceNames: ["Face F1", "Face F2"], boundSelectionId: null, onCreate: vi.fn(() => null), onRename: vi.fn(() => null), onDelete: vi.fn(() => null), onUse: vi.fn(), ...overrides };
}

describe("NamedSelectionsDialog", () => {
  test("is a labelled modal dialog with a named save field and one row of actions per named selection", () => {
    const html = renderToStaticMarkup(<NamedSelectionsDialog study={study} manager={manager()} onClose={vi.fn()} />);
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="[^"]+-title"/);
    expect(html).toContain(">Named selections</h2>");
    expect(html).toContain("2 faces selected: Face F1, Face F2.");
    expect(html).toContain("<label class=\"field\">Name<input");
    expect(html).toContain('<button class="primary" type="submit">Save selection</button>');
    // Automatic per-face selections are not listed; managed ones are, with their use.
    expect(html).not.toContain("<strong>Face F1</strong>");
    expect(html).toContain("<strong>Bolt holes</strong>");
    expect(html).toContain("2 faces · used by Support FS 1");
    expect(html).toContain("1 face · not used");
    for (const action of ["Use Bolt holes", "Rename Bolt holes", "Use Spare", "Rename Spare", "Delete Spare"]) {
      expect(html).toContain(`aria-label="${action}"`);
    }
    expect(html).toContain('<p class="visually-hidden" role="status" aria-live="polite">');
  });

  test("offers Delete only for a named selection nothing uses", () => {
    const html = renderToStaticMarkup(<NamedSelectionsDialog study={study} manager={manager()} onClose={vi.fn()} />);
    expect(html).toMatch(/aria-label="Delete Bolt holes" aria-describedby="[^"]+" disabled=""/);
    expect(html).not.toMatch(/aria-label="Delete Spare" aria-describedby="[^"]+" disabled=""/);
  });

  test("cannot save an empty selection and says how to build one", () => {
    const html = renderToStaticMarkup(<NamedSelectionsDialog study={{ ...study, namedSelections: study.namedSelections.slice(0, 2), constraints: [] } as Study} manager={manager({ selectedFaceNames: [] })} onClose={vi.fn()} />);
    expect(html).toContain("No faces selected. Pick a face in the viewer, Ctrl-click (⌘-click on Mac) to add more, then save them here.");
    expect(html).toContain('<button class="primary" type="submit" disabled="">Save selection</button>');
    expect(html).toContain("None yet.");
  });
});
