import { describe, expect, test } from "vitest";
import { REQUIRED_SETTING_HELP_IDS, SETTING_HELP } from "./settingHelp";

describe("setting help content", () => {
  test("documents every major configuration option with text and a visual", () => {
    for (const id of REQUIRED_SETTING_HELP_IDS) {
      const help = SETTING_HELP[id];

      expect(help, id).toBeDefined();
      expect(help.title.trim().length, id).toBeGreaterThan(3);
      expect(help.body.trim().length, id).toBeGreaterThan(40);
      expect(help.visual, id).toBeDefined();
    }
  });

  // Help that describes behaviour the app does not have is worse than no help:
  // these two entries each shipped a claim the code contradicted.
  test("does not promise model rotation the orientation buttons never perform", () => {
    // handleRotateModel only aims the camera (WorkspaceApp.tsx), and
    // rotateDisplayModel has no production call site, so displayModel.orientation
    // stays zero and the panel only offers Reset for a project saved rotated.
    expect(SETTING_HELP.orientation.body).not.toMatch(/rotates the (imported )?model/i);
    expect(SETTING_HELP.orientation.body).toMatch(/camera/i);
    expect(SETTING_HELP.orientation.body).not.toMatch(/greyed out/i);
  });

  test("does not tell the reader the picked load point changes the solve", () => {
    // Force, pressure and payload gravity become surface loads over the whole
    // selected face (libs/openfea-mesh-intake coreModelFromMesh); the picked
    // point only places the viewer marker, as the Loads panel callout says.
    expect(SETTING_HELP.loadPlacement.body).not.toMatch(/exact point/i);
    expect(SETTING_HELP.loadPlacement.body).not.toMatch(/applied from that object center/i);
    expect(SETTING_HELP.loadPlacement.body).toMatch(/does not change the solve/i);
  });

  test("tells the reader what the load case Enabled toggle actually does", () => {
    // The solver filters on loadCase.enabled (libs/openfea-core-adapter), and
    // only enabled cases become result variants.
    expect(SETTING_HELP.loadCases.body).toMatch(/enabled/i);
  });
});
