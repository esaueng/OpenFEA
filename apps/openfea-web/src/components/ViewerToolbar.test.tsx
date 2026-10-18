import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { ViewerToolbar } from "./ViewerToolbar";
import type { SectionPlaneState } from "../workspaceViewTypes";

const closedSection: SectionPlaneState = { enabled: false, axis: "y", offset: 0.37, flipped: false };
const baseProps = {
  projectionMode: "perspective" as const,
  showDimensions: false,
  sectionPlane: closedSection,
  meshShown: false,
  onCameraView: vi.fn()
};

describe("ViewerToolbar", () => {
  test("is one labelled toolbar with fit, views, section, mesh and dimensions", () => {
    const html = renderToStaticMarkup(<ViewerToolbar {...baseProps} />);
    expect(html).toContain('class="viewer-toolbar" role="toolbar" aria-label="View"');
    for (const label of ["Fit", "Views", "Section", "Mesh", "Dimensions"]) {
      expect(html).toContain(`<span class="viewer-toolbar-label">${label}</span>`);
    }
    // The Views trigger is a menu button; the menu itself renders only when opened.
    expect(html).toContain('aria-haspopup="menu" aria-expanded="false" aria-controls="viewer-views-menu"');
    expect(html).not.toContain('role="menu"');
  });

  test("reports toggle state on section, mesh and dimensions", () => {
    const html = renderToStaticMarkup(<ViewerToolbar {...baseProps} showDimensions meshShown sectionPlane={{ ...closedSection, enabled: true }} />);
    expect(html.match(/aria-pressed="true"/g)?.length).toBeGreaterThanOrEqual(3);
  });

  test("hides the mesh toggle where the viewer owns its own view mode", () => {
    const html = renderToStaticMarkup(<ViewerToolbar {...baseProps} meshShown={null} />);
    expect(html).not.toContain(">Mesh<");
  });

  test("shows axis, offset, flip and close controls while a section is open", () => {
    const closed = renderToStaticMarkup(<ViewerToolbar {...baseProps} />);
    expect(closed).not.toContain("viewer-section-card");

    const html = renderToStaticMarkup(<ViewerToolbar {...baseProps} sectionPlane={{ ...closedSection, enabled: true }} />);
    expect(html).toContain('role="group" aria-label="Section plane"');
    expect(html).toContain('aria-label="Section plane axis"');
    expect(html).toContain('aria-pressed="true">Y</button>');
    expect(html).toContain("Offset · 37%");
    expect(html).toContain('aria-label="Flip cut side"');
    expect(html).toContain('aria-label="Close section"');
  });
});
