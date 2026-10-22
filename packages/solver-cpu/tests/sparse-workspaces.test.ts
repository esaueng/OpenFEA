import { describe, expect, test } from "vitest";
import { CooAccumulator, solveConjugateGradient, sparseMatVec } from "../src";

function problem(size = 96) {
  const builder = new CooAccumulator(size);
  const expected = Float64Array.from({ length: size }, (_, i) => 1 + Math.sin(i * 0.37) + Math.cos(i * 0.13));
  const rhs = new Float64Array(size);
  for (let row = 0; row < size; row += 1) {
    builder.addEntry(row, row, 2.02);
    rhs[row] = 2.02 * expected[row];
    if (row > 0) {
      builder.addEntry(row, row - 1, -1);
      rhs[row] -= expected[row - 1];
    }
    if (row + 1 < size) {
      builder.addEntry(row, row + 1, -1);
      rhs[row] -= expected[row + 1];
    }
  }
  return { matrix: builder.finalizeCsr(), rhs, expected };
}

function countAllocations<T>(operation: () => T) {
  const Native = globalThis.Float64Array;
  let allocations = 0;
  globalThis.Float64Array = new Proxy(Native, {
    construct(target, args) {
      allocations += 1;
      return Reflect.construct(target, args, target);
    }
  });
  try {
    return { result: operation(), allocations };
  } finally {
    globalThis.Float64Array = Native;
  }
}

describe("solve-local sparse workspaces", () => {
  test.each(["none", "jacobi", "ssor"] as const)("bounds %s allocations independently of iteration count", (preconditioner) => {
    const { matrix, rhs, expected } = problem();
    const guess = Float64Array.from(expected, (value) => value * 0.1);
    const savedGuess = guess.slice();
    const run = (maxIterations: number) => countAllocations(() => solveConjugateGradient(matrix, rhs, {
      preconditioner, initialGuess: guess, maxIterations, tolerance: 1e-12
    }));
    const short = run(5);
    const complete = run(256);
    expect(short.result).toMatchObject({ ok: false, error: { code: "cg-not-converged" }, iterations: 5 });
    expect(complete.result.ok).toBe(true);
    expect(complete.result.iterations).toBeGreaterThan(5);
    expect(short.allocations).toBeLessThanOrEqual(8);
    expect(complete.allocations).toBe(short.allocations);
    expect(guess).toEqual(savedGuess);
    if (complete.result.ok) {
      complete.result.solution.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 7));
      expect(complete.result.relativeResidual).toBeLessThanOrEqual(1e-12);
    }
  });

  test("keeps workspaces isolated when a progress hook runs another solve", () => {
    const outer = problem();
    const inner = problem(17);
    const options = { preconditioner: "ssor" as const, tolerance: 1e-12, maxIterations: 256 };
    const reference = solveConjugateGradient(outer.matrix, outer.rhs, options);
    let nested = false;
    const result = solveConjugateGradient(outer.matrix, outer.rhs, {
      ...options,
      hooks: { onProgress: ({ iteration }) => {
        if (iteration !== 25 || nested) return;
        nested = true;
        const solved = solveConjugateGradient(inner.matrix, inner.rhs, { ...options, preconditioner: "jacobi" });
        expect(solved.ok).toBe(true);
        if (solved.ok) solved.solution.forEach((value, i) => expect(value).toBeCloseTo(inner.expected[i], 8));
      } }
    });
    expect(nested).toBe(true);
    expect(result).toEqual(reference);
  });

  test("keeps public matrix-vector results independently owned", () => {
    const { matrix, rhs } = problem(17);
    const first = sparseMatVec(matrix, rhs);
    const saved = first.slice();
    const second = sparseMatVec(matrix, new Float64Array(rhs.length));
    expect(second).not.toBe(first);
    expect(first).toEqual(saved);
    expect(second).toEqual(new Float64Array(rhs.length));
  });
});
