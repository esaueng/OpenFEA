import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DisplayFace } from "@openfea/schema";
import { faceButtonPickIntent, FaceSelectionOverlay } from "./FaceSelectionOverlay";

const faces: DisplayFace[] = ["Top", "Bottom", "Wall", "Hole"].map((label, index) => ({
  id: `face-${index}`,
  label: `${label} face`,
  color: "#888888",
  center: [0, 0, index],
  normal: [0, 0, 1],
  stressValue: 0
}));

function render(props: Partial<Parameters<typeof FaceSelectionOverlay>[0]> = {}) {
  return renderToStaticMarkup(
    <FaceSelectionOverlay faces={faces} selectedFaceId={null} showSelectionChip onSelectFace={() => undefined} {...props} />
  );
}

describe("FaceSelectionOverlay", () => {
  test("marks every face in the working selection as pressed in the keyboard face list", () => {
    const html = render({ selectedFaceId: "face-0", additionalSelectedFaceIds: ["face-2"] });
    expect(html).toContain('aria-pressed="true">Top face</button>');
    expect(html).toContain('aria-pressed="false">Bottom face</button>');
    expect(html).toContain('aria-pressed="true">Wall face</button>');
    expect(html).toContain("Add to selection");
  });

  test("names the primary face on the chip and announces how many faces are selected", () => {
    const html = render({ selectedFaceId: "face-0", additionalSelectedFaceIds: ["face-2", "face-3"] });
    expect(html).toContain('role="status"');
    expect(html).toContain("Selected: Top face +2 faces");
    expect(html).toContain("3 faces selected");
    const single = render({ selectedFaceId: "face-1" });
    expect(single).toContain("Selected: Bottom face");
    expect(single).not.toContain("faces selected");
  });

  test("shows no chip outside Supports and Loads", () => {
    expect(render({ selectedFaceId: "face-0", showSelectionChip: false })).not.toContain("viewer-selection-chip");
  });

  test("a face button toggles while Add to selection is on or Ctrl/Cmd is held", () => {
    expect(faceButtonPickIntent(false, {})).toBe("replace");
    expect(faceButtonPickIntent(true, {})).toBe("toggle");
    expect(faceButtonPickIntent(false, { ctrlKey: true })).toBe("toggle");
    expect(faceButtonPickIntent(false, { metaKey: true })).toBe("toggle");
  });
});
