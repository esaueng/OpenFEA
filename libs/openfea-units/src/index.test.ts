import { describe, expect, test } from "vitest";
import {
  foundationModulusFromNewtonsPerCubicMetre,
  foundationModulusToNewtonsPerCubicMetre,
  foundationModulusToSolverUnits,
  meshVolumeM3FromTriangles,
  PASCALS_PER_PSI,
  pressureToPascals,
  pressureToSolverStress,
  solverMassToKilograms,
  STANDARD_GRAVITY,
  stlDimensionsFromBytes,
  stlVolumeM3FromBytes
} from ".";

function binaryStl(vertices: [number, number, number][]): Uint8Array {
  const triangleCount = vertices.length / 3;
  const bytes = new Uint8Array(84 + triangleCount * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangleCount, true);
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const offset = 84 + triangleIndex * 50 + 12;
    for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
      const vertex = vertices[triangleIndex * 3 + vertexIndex]!;
      for (let axis = 0; axis < 3; axis += 1) {
        view.setFloat32(offset + vertexIndex * 12 + axis * 4, vertex[axis]!, true);
      }
    }
  }
  return bytes;
}

describe("foundation modulus (elastic supports, plan 036 R1.5)", () => {
  test("converts N/m^3 to each solver system and display unit", () => {
    expect(foundationModulusToSolverUnits(5e7, "m-N-s-Pa")).toBe(5e7);
    // 1 N/mm^3 = 1e9 N/m^3: force/area/length scales by 1e-3 cubed.
    expect(foundationModulusToSolverUnits(5e7, "mm-N-s-MPa")).toBeCloseTo(0.05, 15);
    expect(foundationModulusToNewtonsPerCubicMetre(0.05, "N/mm^3")).toBeCloseTo(5e7, 6);
    // 1 lbf/in^3 (pci) = 271,447.14 N/m^3.
    expect(foundationModulusToNewtonsPerCubicMetre(1, "lbf/in^3")).toBeCloseTo(271_447.14, 1);
    expect(foundationModulusFromNewtonsPerCubicMetre(foundationModulusToNewtonsPerCubicMetre(123, "lbf/in^3"), "lbf/in^3")).toBeCloseTo(123, 9);
  });
});

describe("STL dimensions", () => {
  test("reads binary STL extents without normalizing display scale", () => {
    const bytes = binaryStl([
      [14.14, 7.45, -1],
      [282.94, 7.45, -1],
      [14.14, 297.35, 245.05]
    ]);

    expect(stlDimensionsFromBytes(bytes)).toEqual({
      x: 268.8,
      y: 246.1,
      z: 289.9,
      units: "mm"
    });
  });

  test("reads ASCII STL extents", () => {
    const bytes = new TextEncoder().encode(`
solid part
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 25.4 0 0
vertex 0 50.8 76.2
endloop
endfacet
endsolid part
`);

    expect(stlDimensionsFromBytes(bytes)).toEqual({
      x: 25.4,
      y: 76.2,
      z: 50.8,
      units: "mm"
    });
  });

  test("ignores long malformed ASCII STL content without regex parsing", () => {
    const malformedLines = Array.from({ length: 20_000 }, (_, index) => `not-a-vertex ${index} ${"x".repeat(20)}`).join("\n");
    const bytes = new TextEncoder().encode(`solid malformed\n${malformedLines}\nendsolid malformed`);

    expect(stlDimensionsFromBytes(bytes)).toBeUndefined();
  });

  test("rejects ASCII STL vertices with non-finite coordinates", () => {
    const bytes = new TextEncoder().encode(`
solid invalid
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex Infinity 0 0
vertex 0 1 0
endloop
endfacet
endsolid invalid
`);

    expect(stlDimensionsFromBytes(bytes)).toBeUndefined();
  });
});

describe("mesh volume", () => {
  test("computes closed mesh volume in cubic meters from millimeter vertices", () => {
    const size = 10;
    const p = {
      a: [0, 0, 0] as [number, number, number],
      b: [size, 0, 0] as [number, number, number],
      c: [size, size, 0] as [number, number, number],
      d: [0, size, 0] as [number, number, number],
      e: [0, 0, size] as [number, number, number],
      f: [size, 0, size] as [number, number, number],
      g: [size, size, size] as [number, number, number],
      h: [0, size, size] as [number, number, number]
    };
    const triangles: Array<[[number, number, number], [number, number, number], [number, number, number]]> = [
      [p.a, p.c, p.b], [p.a, p.d, p.c],
      [p.e, p.f, p.g], [p.e, p.g, p.h],
      [p.a, p.b, p.f], [p.a, p.f, p.e],
      [p.d, p.h, p.g], [p.d, p.g, p.c],
      [p.a, p.e, p.h], [p.a, p.h, p.d],
      [p.b, p.c, p.g], [p.b, p.g, p.f]
    ];

    expect(meshVolumeM3FromTriangles(triangles)).toBeCloseTo(0.000001);
  });

  test("computes ASCII STL volume from triangles", () => {
    const bytes = new TextEncoder().encode(`
solid tetra
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 100 0 0
vertex 0 100 0
endloop
endfacet
facet normal 1 0 0
outer loop
vertex 0 0 0
vertex 0 0 100
vertex 100 0 0
endloop
endfacet
facet normal 0 1 0
outer loop
vertex 0 0 0
vertex 0 100 0
vertex 0 0 100
endloop
endfacet
facet normal 1 1 1
outer loop
vertex 100 0 0
vertex 0 0 100
vertex 0 100 0
endloop
endfacet
endsolid tetra
`);

    expect(stlVolumeM3FromBytes(bytes)).toBeCloseTo(1 / 6000);
  });
});

describe("solver mass units", () => {
  test("converts mm-N-s-MPa tonnes and m-N-s-Pa kilograms to kilograms", () => {
    expect(Math.abs(solverMassToKilograms(10.8, "kg") - 10.8)).toBeLessThan(1e-12);
    expect(Math.abs(solverMassToKilograms(0.0108, "t") - 10.8)).toBeLessThan(1e-12);
  });
});

describe("pressure and stress units", () => {
  test("converts study pressure labels to pascals", () => {
    expect(pressureToPascals(250, "Pa")).toBe(250);
    expect(pressureToPascals(125, "kPa")).toBe(125_000);
    expect(pressureToPascals(2.5, "MPa")).toBe(2_500_000);
    expect(pressureToPascals(10, "psi")).toBeCloseTo(10 * PASCALS_PER_PSI, 9);
    expect(PASCALS_PER_PSI).toBe(6894.757293168);
  });

  test("emits Pa for m-N-s-Pa and MPa (Pa / 1e6) for mm-N-s-MPa solver models", () => {
    for (const [value, units] of [[250, "Pa"], [125, "kPa"], [2.5, "MPa"], [10, "psi"]] as const) {
      const pascals = pressureToPascals(value, units);
      expect(pressureToSolverStress(value, units, "m-N-s-Pa")).toBe(pascals);
      expect(pressureToSolverStress(value, units, "mm-N-s-MPa")).toBeCloseTo(pascals / 1_000_000, 12);
    }
    expect(pressureToSolverStress(2.5, "MPa", "mm-N-s-MPa")).toBe(2.5);
  });

  test("keeps the historical Pa reading for missing and unrecognised unit labels", () => {
    expect(pressureToPascals(7, undefined)).toBe(7);
    expect(pressureToPascals(7, "bar")).toBe(7);
    expect(pressureToPascals(7, "constructor")).toBe(7);
    expect(pressureToSolverStress(7, undefined, "mm-N-s-MPa")).toBeCloseTo(7e-6, 15);
  });

  test("exports standard gravity in m/s^2", () => {
    expect(STANDARD_GRAVITY).toBe(9.80665);
  });
});
