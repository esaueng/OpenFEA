import { expect, test } from "vitest";
import { ConstraintSchema, DynamicSolverSettingsSchema, LoadSchema } from "./index";

test("boundary schemas preserve arbitrary parameter records and strip unknown envelope fields", () => {
  const parameters = { value: 500, units: "N", direction: [0, 0, -1], enabled: false, metadata: { source: "user", optional: null } };
  const boundary = { id: "boundary-1", selectionRef: "face-1", parameters, status: "ready" };
  for (const [schema, type] of [[LoadSchema, "force"], [ConstraintSchema, "fixed"]] as const) {
    expect(schema.parse({ ...boundary, type, unknownEnvelopeField: "discard" })).toEqual({ ...boundary, type });
    for (const invalid of [null, 1, "force", []]) {
      expect(schema.safeParse({ ...boundary, type, parameters: invalid }).success).toBe(false);
    }
  }
});

test("dynamic solver defaults retain the saved-project format and omitted optional fields", () => {
  expect(DynamicSolverSettingsSchema.parse({})).toEqual({
    startTime: 0,
    endTime: 0.1,
    timeStep: 0.005,
    outputInterval: 0.005,
    dampingRatio: 0.02,
    integrationMethod: "newmark_average_acceleration",
    loadProfile: "ramp"
  });
});
