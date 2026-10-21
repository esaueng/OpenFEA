import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

async function main() {
  const source = resolve(process.argv[2] ?? '.');
  const { solveConjugateGradient } = await import(pathToFileURL(`${source}/packages/solver-cpu/src/sparse.ts`).href);
  function problem(n: number) {
    const rowPtr = new Int32Array(n + 1), colInd = new Int32Array(n * 3 - 2), values = new Float64Array(n * 3 - 2);
    const rhs = new Float64Array(n);
    let entry = 0;
    for (let row = 0; row < n; row++) {
      rowPtr[row] = entry;
      if (row) { colInd[entry] = row - 1; values[entry++] = -1; }
      colInd[entry] = row; values[entry++] = 2.01;
      if (row + 1 < n) { colInd[entry] = row + 1; values[entry++] = -1; }
      rhs[row] = 1 + Math.sin(row * 0.37) + Math.cos(row * 0.013);
    }
    rowPtr[n] = entry;
    return { matrix: { rowCount: n, colCount: n, rowPtr, colInd, values }, rhs };
  }
  const warm = problem(64);
  for (const preconditioner of ['none', 'jacobi', 'ssor']) {
    for (let i = 0; i < 8; i++) solveConjugateGradient(warm.matrix, warm.rhs, { preconditioner });
    for (const n of [30_000, 75_000, 150_000]) {
      const { matrix, rhs } = problem(n);
      for (let trial = 0; trial < 5; trial++) {
        const Native = globalThis.Float64Array;
        let allocations = 0, bytes = 0;
        if (process.env.CG_COUNT_ALLOCATIONS !== '0') globalThis.Float64Array = new Proxy(Native, { construct(target, args) {
          const array = Reflect.construct(target, args, target) as Float64Array;
          allocations++; bytes += array.byteLength;
          return array;
        } });
        const started = performance.now();
        try {
          const result = solveConjugateGradient(matrix, rhs, { preconditioner, tolerance: 1e-8, maxIterations: 512 });
          console.log(JSON.stringify({ n, preconditioner, trial, ok: result.ok, iterations: result.iterations, residualNorm: result.residualNorm, relativeResidual: result.relativeResidual,
            allocations, bytes, milliseconds: performance.now() - started,
            solutionHash: result.ok ? createHash('sha256').update(Buffer.from(result.solution.buffer, result.solution.byteOffset, result.solution.byteLength)).digest('hex') : null }));
        } finally { globalThis.Float64Array = Native; }
      }
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
