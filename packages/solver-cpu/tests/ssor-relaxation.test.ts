import { describe, expect, test } from "vitest";
import { CooAccumulator, norm, solveConjugateGradient, sparseMatVec } from "../src";
import { applySsorPreconditioner } from "../src/sparse";

describe("SSOR relaxation", () => {
  test.each([0.5, 1, 1.4, 1.8])("matches the symmetric dense inverse at omega=%s", (omega) => {
    const builder = new CooAccumulator(2);
    for (const [row, col, value] of [[0, 0, 4], [0, 1, 1], [1, 0, 1], [1, 1, 3]]) builder.addEntry(row, col, value);
    const matrix = builder.finalizeCsr();
    const first = new Float64Array([0, 0, 123]);
    const second = new Float64Array(2);
    applySsorPreconditioner(matrix, new Float64Array([1, 0]), first, undefined, omega);
    applySsorPreconditioner(matrix, new Float64Array([0, 1]), second, undefined, omega);
    // M^-1 = omega(2-omega)/12 * [[3+omega²/4, -omega], [-omega, 4]].
    const factor = omega * (2 - omega) / 12;
    expect(first[0]).toBeCloseTo(factor * (3 + omega * omega / 4), 14);
    expect(first[1]).toBeCloseTo(-factor * omega, 14);
    expect(second[0]).toBeCloseTo(-factor * omega, 14);
    expect(second[1]).toBeCloseTo(factor * 4, 14);
    expect(first[1]).toBeCloseTo(second[0], 14);
    expect(first[2]).toBe(123);
    expect(first[0] * second[1] - first[1] * second[0]).toBeGreaterThan(0);
  });

  test.each([0.5, 1.4, 1.8])("converges to an independent tridiagonal solution at omega=%s", (ssorOmega) => {
    const size = 17;
    const expected = Float64Array.from({ length: size }, (_, i) => 1 + Math.sin(i * 0.37) + Math.cos(i * 0.13));
    const rhs = new Float64Array(size);
    const builder = new CooAccumulator(size);
    for (let row = 0; row < size; row += 1) {
      builder.addEntry(row, row, 2.02);
      rhs[row] = 2.02 * expected[row];
      if (row > 0) { builder.addEntry(row, row - 1, -1); rhs[row] -= expected[row - 1]; }
      if (row + 1 < size) { builder.addEntry(row, row + 1, -1); rhs[row] -= expected[row + 1]; }
    }
    const matrix = builder.finalizeCsr();
    const solved = solveConjugateGradient(matrix, rhs, { preconditioner: "ssor", ssorOmega, tolerance: 1e-12, maxIterations: 64 });
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    solved.solution.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 8));
    const residual = sparseMatVec(matrix, solved.solution);
    residual.forEach((value, i) => { residual[i] = value - rhs[i]; });
    expect(norm(residual) / norm(rhs)).toBeLessThanOrEqual(1e-12);
  });
});
