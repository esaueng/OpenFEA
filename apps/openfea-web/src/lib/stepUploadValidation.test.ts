import { afterEach, expect, test, vi } from "vitest";
import { bracketDemoProject } from "@openfea/samples";
import { uploadModel } from "./api";

vi.mock("../stepFaces", () => ({ stepFaceRegistryFromBase64: async () => ({ displayFaces: [] }), stepRegistryDimensions: () => undefined }));
const { inspect } = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock("../workers/meshWorkerClient", () => ({ inspectStepFileInWorker: inspect }));
afterEach(() => vi.unstubAllGlobals());

test("rejects invalid STEP topology without replacing the existing geometry or study", async () => {
  vi.stubGlobal("Worker", class {});
  inspect.mockResolvedValue({ inspection: {
    status: "invalid", volumeCount: 0, surfaceCount: 0, orphanSurfaceCount: 0,
    openBoundaryCurveCount: 0, surfaceMeshValid: false, repairable: false,
    issue: "import_failed", message: "The STEP file contains no usable solid or surface geometry."
  } });
  const original = structuredClone(bracketDemoProject);
  const before = structuredClone(original);
  const file = new File(["ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nINVALID"], "invalid.step");
  await expect(uploadModel(original.id, file, original)).rejects.toThrow("no usable solid or surface geometry");
  expect(original).toEqual(before);
});

test("continues accepting a real open surface shell for the repair workflow", async () => {
  vi.stubGlobal("Worker", class {});
  inspect.mockResolvedValue({ inspection: {
    status: "open_shell", volumeCount: 0, surfaceCount: 5, orphanSurfaceCount: 5,
    openBoundaryCurveCount: 4, surfaceMeshValid: true, repairable: false, issue: "no_solid_volume"
  } });
  const response = await uploadModel(bracketDemoProject.id, new File(["shell"], "shell.step"), bracketDemoProject);
  expect(response.project.geometryFiles[0]?.metadata.stepGeometry).toMatchObject({ status: "repairable" });
});
