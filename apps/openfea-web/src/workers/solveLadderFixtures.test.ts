import { describe, expect, it } from "vitest";
import { DEFAULT_STRUCTURAL_MAX_DOFS, computeTet4Geometry } from "@openfea/solver-cpu";
import {
  buildLadderFixture,
  ladderCases,
  ladderGrid,
  ladderTimoshenkoTipDeflection,
  LADDER_RUNG_TARGET_DOFS,
  type LadderOrder,
  type LadderRung,
  type LadderShape
} from "./solveLadderFixtures";
import { runLadderCase } from "./solveLadderRun";

const shapes: LadderShape[] = ["block", "slender"];
const orders: LadderOrder[] = ["Tet4", "Tet10"];
const rungs = Object.keys(LADDER_RUNG_TARGET_DOFS) as LadderRung[];

describe("solve-ladder fixtures", () => {
  it("lands every rung within 5% under its target and never above the product ceiling", () => {
    for (const shape of shapes) {
      for (const order of orders) {
        for (const rung of rungs) {
          const grid = ladderGrid(shape, order, LADDER_RUNG_TARGET_DOFS[rung]);
          expect(grid.dofs).toBeLessThanOrEqual(LADDER_RUNG_TARGET_DOFS[rung]);
          expect(grid.dofs).toBeGreaterThanOrEqual(0.95 * LADDER_RUNG_TARGET_DOFS[rung]);
          expect(grid.dofs).toBeLessThanOrEqual(DEFAULT_STRUCTURAL_MAX_DOFS);
        }
      }
    }
  });

  it("is deterministic and conforming with positively oriented elements", () => {
    const fixture = buildLadderFixture("slender", "Tet4", "30k");
    expect(buildLadderFixture("slender", "Tet4", "30k").fingerprint).toBe(fixture.fingerprint);
    const { coordinates } = fixture.model.nodes;
    const connectivity = fixture.model.elementBlocks[0]!.connectivity;
    const faceUse = new Map<string, number>();
    for (let element = 0; element < connectivity.length / 4; element += 1) {
      const nodes = connectivity.slice(element * 4, element * 4 + 4);
      const elementCoordinates = new Float64Array(nodes.flatMap((node) => [coordinates[node * 3]!, coordinates[node * 3 + 1]!, coordinates[node * 3 + 2]!]));
      expect(computeTet4Geometry(elementCoordinates).ok).toBe(true);
      for (const omit of [0, 1, 2, 3]) {
        const key = nodes.filter((_node, index) => index !== omit).sort((a, b) => a - b).join(":");
        faceUse.set(key, (faceUse.get(key) ?? 0) + 1);
      }
    }
    expect(Math.max(...faceUse.values())).toBe(2);
    const { nx, ny, nz } = fixture.grid;
    const boundaryFaces = [...faceUse.values()].filter((count) => count === 1).length;
    expect(boundaryFaces).toBe(4 * (ny * nz + nx * nz + nx * ny));
  });

  it("puts Tet10 midside nodes on the half grid", () => {
    const fixture = buildLadderFixture("block", "Tet10", "30k");
    const { nx, ny, nz } = fixture.grid;
    expect(fixture.model.nodes.coordinates.length / 3).toBe((2 * nx + 1) * (2 * ny + 1) * (2 * nz + 1));
    expect(fixture.fixedNodeCount).toBe((2 * ny + 1) * (2 * nz + 1));
  });

  it("covers static at every rung and the modal/dynamic baseline at 30k", () => {
    const cases = ladderCases();
    expect(cases.filter((entry) => entry.analysis === "static")).toHaveLength(12);
    expect(cases.filter((entry) => entry.analysis !== "static").every((entry) => entry.rung === "30k")).toBe(true);
    expect(cases).toHaveLength(20);
  });

  it("uses the hand-checked Timoshenko reference for the slender cantilever", () => {
    // 100 N * 1000^3 / (3 * 200000 * 20^4/12) = 12.5 mm bending + 0.0038 mm shear.
    expect(ladderTimoshenkoTipDeflection("slender")).toBeCloseTo(12.5038, 3);
  });

  it("solves the cheapest rung through the production static path in equilibrium", () => {
    const result = runLadderCase({ shape: "block", order: "Tet4", rung: "30k", analysis: "static" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.preconditioner).toBe("ssor");
    expect(result.parity?.reactionBalanceRelError).toBeLessThan(1e-6);
    expect(result.coreResultValid).toBe(true);
  }, 60_000);
});
