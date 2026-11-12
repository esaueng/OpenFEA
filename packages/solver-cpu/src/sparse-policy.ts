/**
 * Sparse-algebra tolerances are dimensionless or scaled by matrix magnitudes.
 * They must not encode a force, stiffness, or geometry unit system.
 */
export const SPARSE_ALGEBRA_POLICY = Object.freeze({
  /** Relative CG stopping criterion, measured against the true RHS norm. */
  defaultRelativeResidualTolerance: 1e-10,
  /** Machine-precision multiplier for the p^T A p curvature check. */
  curvatureEpsilonMultiplier: 16,
  /** Machine-precision multiplier for deciding whether a scaled diagonal is usable. */
  diagonalEpsilonMultiplier: 64,
  /** SSOR relaxation is restricted to the mathematically open interval (0, 2). */
  relaxationEndpointEpsilonMultiplier: 1,
  /**
   * CG's recursively updated residual drifts from the true residual b - Ax in
   * long ill-conditioned runs. When the recursive residual meets tolerance but
   * the recomputed true residual does not, CG restarts from the current x with
   * the true residual at most this many times before reporting partial
   * convergence.
   */
  trueResidualRestartCycles: 2,
  /**
   * A restart cycle may use at most this fraction of the first cycle's
   * iterations (and never more than the remaining maxIterations budget), so
   * drift recovery adds at most half the first cycle's iterations to a long
   * slender solve.
   */
  trueResidualRestartIterationFraction: 0.25,
  /**
   * Dimensionless: a restart cycle must shrink the true residual to at most
   * this fraction of its previous value, otherwise the floating-point floor
   * has been reached and further restarts are skipped.
   */
  trueResidualRestartMinimumReduction: 0.5
});

/**
 * FEM assembly retains every finite representable contribution, including
 * subnormals, and drops only values that are exactly zero after IEEE-754
 * underflow or duplicate cancellation. No dimensional magnitude is implied.
 */
export function retainSparseAssemblyValue(value: number): boolean {
  return value !== 0;
}

/** Relative, matrix-scale-aware floor for Jacobi/SSOR diagonal division. */
export function sparseDiagonalTolerance(diagonal: ArrayLike<number>): number {
  let scale = 0;
  for (let index = 0; index < diagonal.length; index += 1) {
    const magnitude = Math.abs(diagonal[index] ?? 0);
    if (magnitude > scale) scale = magnitude;
  }
  return SPARSE_ALGEBRA_POLICY.diagonalEpsilonMultiplier * Number.EPSILON * scale;
}

/** Relative curvature floor scaled by the current Krylov vectors. */
export function sparseCurvatureTolerance(searchNorm: number, productNorm: number): number {
  return SPARSE_ALGEBRA_POLICY.curvatureEpsilonMultiplier * Number.EPSILON * searchNorm * productNorm;
}

export function usableSparseDiagonal(value: number, tolerance: number): boolean {
  return Number.isFinite(value) && Math.abs(value) > tolerance;
}

export function validSparseSsorOmega(value: number | undefined): number {
  const endpoint = SPARSE_ALGEBRA_POLICY.relaxationEndpointEpsilonMultiplier * Number.EPSILON;
  return value !== undefined && Number.isFinite(value) && value > endpoint && value < 2 - endpoint ? value : 1;
}
