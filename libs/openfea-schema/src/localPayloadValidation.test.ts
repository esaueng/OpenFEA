import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ProjectSchema, ResultSummarySchema, safeParseLocalPayload, safeParseLocalProject } from "./index";
import { firstIssueOnly } from "./localPayloadValidation";

const project = {
  id: "p", name: "Project", schemaVersion: "1", unitSystem: "SI",
  geometryFiles: [], studies: [], createdAt: "", updatedAt: ""
};
const study = {
  id: "s", projectId: "p", name: "Study", type: "static_stress",
  geometryScope: [], materialAssignments: [], namedSelections: [], constraints: [],
  loads: [], meshSettings: { preset: "medium", status: "not_started" },
  solverSettings: { backend: "opencae_core_cloud" }
};

function unreadableTail(first: unknown): unknown[] {
  const values = Array.from({ length: 10_000 }, () => first);
  Object.defineProperty(values, 1, { get() { throw new Error("Read beyond the first invalid entry"); } });
  return values;
}

describe("local payload validation", () => {
  it("rejects invalid study batches before examining a second entry", () => {
    const parsed = safeParseLocalProject({ ...project, studies: unreadableTail({}) });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toHaveLength(1);
  });

  it("stops continuable scalar checks inside nested collections", () => {
    expect(safeParseLocalProject({
      ...project, studies: [{ ...study, materialAssignments: unreadableTail({
        id: "a", materialId: "m", selectionRef: "s", status: "ready", bodyId: ""
      }) }]
    }).success).toBe(false);
    expect(safeParseLocalProject({ ...project, customMaterials: unreadableTail({
      id: "2b9692b5-5fb0-4bfd-93b4-158fc5fb9477", name: "Bad material", category: "metal",
      verification: "user_supplied_unverified", youngsModulus: -1, poissonRatio: 0.3,
      density: 1, yieldStrength: 1
    }) }).success).toBe(false);
  });

  it("keeps existing array size refusals ahead of child validation", () => {
    const values = [1, 1, 1];
    Object.defineProperty(values, 0, { get() { throw new Error("Oversized child was read"); } });
    for (const schema of [z.array(z.number()).max(2), z.array(z.number()).length(2)]) {
      expect(safeParseLocalPayload(schema, values).success).toBe(false);
    }
  });

  it("runs custom array refinements with parsed children", () => {
    const seen: number[] = [];
    const schema = z.array(z.object({ value: z.number().default(7) })).max(2).superRefine((entries) => {
      seen.push(entries[0]!.value);
      if (entries[0]!.value !== 7) throw new Error("Refinement received unparsed children");
    });
    expect(safeParseLocalPayload(schema, [{}])).toEqual({ success: true, data: [{ value: 7 }] });
    expect(seen).toEqual([7, 7]);
  });

  it("preserves all analysis types, migration, defaults, passthrough fields and large valid collections", () => {
    const candidate = { ...project, studies: Array.from({ length: 128 }, (_, index) => ({
      ...study, id: `s-${index}`, type: ["static_stress", "dynamic_structural", "modal_analysis", "steady_state_thermal"][index % 4],
      meshSettings: { ...study.meshSettings, summary: { nodes: 1, elements: 1, warnings: [], extension: { retained: true } } }
    })), geometryFiles: [{ id: "g", projectId: "p", filename: "x.step", localPath: "x", artifactKey: "x", status: "ready", metadata: { custom: { deeply: [1, 2, 3] } } }] };
    const expected = ProjectSchema.parse(candidate);
    const actual = safeParseLocalProject(candidate);
    expect(actual.success).toBe(true);
    if (actual.success) expect(actual.data).toEqual(expected);
  });

  it("drops corrupt optional mesh metrics without parsing their entire invalid array", () => {
    const stats = { worst: 0, p5: 0, median: 0, histogram: { min: 0, max: 1, counts: unreadableTail(-1) } };
    const parsed = safeParseLocalProject({ ...project, studies: [{ ...study, meshSettings: {
      ...study.meshSettings, summary: { nodes: 1, elements: 1, warnings: [], qualityMetrics: {
        version: 1, elementType: "Tet4", elementCount: 1, degenerateCount: 0,
        metrics: { scaledJacobian: stats }
      } }
    } }] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.studies[0]?.meshSettings.summary?.qualityMetrics).toBeUndefined();
  });

  it("bounds cross-reference refinements and propagates unexpected exceptions", () => {
    let issues = 0;
    const schema = z.object({}).superRefine(firstIssueOnly((_value, context) => {
      for (let index = 0; index < 10_000; index++) {
        issues++;
        context.addIssue({ code: "custom", message: "Invalid reference" });
      }
    }));
    expect(safeParseLocalPayload(schema, {}).success).toBe(false);
    expect(issues).toBe(1);
    const broken = z.object({}).superRefine(firstIssueOnly(() => { throw new Error("unexpected"); }));
    expect(() => safeParseLocalPayload(broken, {})).toThrow("unexpected");
  });

  it("preflights records, tuples and optional result-like arrays", () => {
    const schema = z.object({ values: z.record(z.string(), z.array(z.tuple([z.number().positive()]))).optional() });
    expect(safeParseLocalPayload(schema, { values: { field: unreadableTail([-1]) } }).success).toBe(false);
  });

  it("preserves later union branches with malformed fields belonging to earlier branches", () => {
    const thermal = {
      analysisType: "steady_state_thermal", minTemperature: 20, maxTemperature: 30,
      temperatureUnits: "K", maxHeatFlux: 1, heatFluxUnits: "W/m2", appliedHeat: 1,
      generatedHeat: 0, reactionHeat: 1, heatRateUnits: "W", energyBalanceRelativeError: 0,
      modes: unreadableTail({})
    };
    const parsed = safeParseLocalPayload(ResultSummarySchema, thermal);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(ResultSummarySchema.parse(thermal));
    // The study union shares its unbounded children, including loads. A later
    // nonstructural branch must remain valid with no structural partition.
    const candidate = { ...project, studies: [{ ...study, type: "steady_state_thermal", loadCases: [], loads:
      Array.from({ length: 128 }, (_, index) => ({ id: `l-${index}`, type: "force", selectionRef: "s", parameters: {}, status: "ready" }))
    }] };
    const result = safeParseLocalProject(candidate);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(ProjectSchema.parse(candidate));
  });
});
