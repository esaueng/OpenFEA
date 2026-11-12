import { bracketSolidVolumeMm3, type BracketGeometryDescriptor } from "@openfea/mesh-intake";
import type { DisplayModel } from "@openfea/schema";

export interface ModelPanelProjectState {
  geometryFiles: Array<{ metadata?: Record<string, unknown> }>;
}

export function shouldShowSampleModelPicker(project: ModelPanelProjectState) {
  return project.geometryFiles.some((file) => file.metadata?.source === "sample" || typeof file.metadata?.sampleModel === "string");
}

type CoreCloudGeometry = NonNullable<DisplayModel["coreCloudGeometry"]>;

/**
 * Volume, in mm^3, of the solid the solver actually meshes for a built-in
 * sample: the structured block of the beam and cantilever, or the procedural
 * bracket (base, upright, rib and bores) of the Bracket Demo. Both come from
 * the geometry descriptor, not from the display model or a STEP file. Any
 * other geometry (uploaded CAD) has no recorded volume and returns undefined
 * rather than a guess.
 */
export function sampleSolidVolumeMm3(geometry: CoreCloudGeometry | undefined): number | undefined {
  if (!geometry?.descriptor) return undefined;
  const mmPerUnit = geometry.units === "m" ? 1_000 : 1;
  let volume: number | undefined;
  if (geometry.kind === "structured_block") {
    const { length, width, height } = geometry.descriptor;
    if (typeof length !== "number" || typeof width !== "number" || typeof height !== "number") return undefined;
    volume = length * width * height * mmPerUnit ** 3;
  } else if (geometry.kind === "sample_procedural" && geometry.sampleId === "bracket") {
    volume = bracketSolidVolumeMm3(geometry.descriptor as BracketGeometryDescriptor) * mmPerUnit ** 3;
  }
  return volume !== undefined && Number.isFinite(volume) && volume > 0 ? volume : undefined;
}

/** What the solver meshes for a built-in sample, worded like the Results mesh-source label. */
export function sampleSolverGeometryLabel(geometry: CoreCloudGeometry | undefined): string | undefined {
  if (geometry?.kind === "sample_procedural") return "Procedural sample (simplified)";
  if (geometry?.kind === "structured_block") return "Structured block";
  return undefined;
}

/** Mass in grams of `volumeMm3` (mm^3) at `densityKgPerM3` (kg/m^3): 1 mm^3 at 1 kg/m^3 is 1e-6 g. */
export function massGramsForVolume(volumeMm3: number, densityKgPerM3: number): number | undefined {
  const grams = volumeMm3 * densityKgPerM3 * 1e-6;
  return Number.isFinite(grams) && grams > 0 ? grams : undefined;
}
