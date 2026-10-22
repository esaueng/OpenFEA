import type { CoreModalMassParticipation, CoreModalMassParticipationMode, NormalizedOpenFEAModel } from "@openfea/core";

type Triple = [number, number, number];

/**
 * Modal participation factors and effective masses per global translation.
 *
 * `mass` is the diagonal lumped mass over the free DOFs (`free[k]` is the
 * global DOF, `free[k] % 3` its direction) — the same matrix the eigen solve
 * used. Each mode vector is a free-DOF eigenvector of any scale or sign: the
 * effective mass Γ²/(φᵀMφ) is invariant to both, and the reported Γ is the
 * value for the φᵀMφ = 1 normalization.
 */
export function modalMassParticipation(input: {
  mass: Float64Array;
  free: Int32Array;
  totalMass: number;
  massUnits: CoreModalMassParticipation["massUnits"];
  computedOnProjectedModel: boolean;
  modes: ReadonlyArray<{ modeIndex: number; vector: Float64Array }>;
}): CoreModalMassParticipation {
  const { mass, free, totalMass } = input;
  const unconstrainedMass: Triple = [0, 0, 0];
  for (let index = 0; index < free.length; index += 1) unconstrainedMass[free[index] % 3] += mass[index];
  const cumulative: Triple = [0, 0, 0];
  const modes = input.modes.map((mode): CoreModalMassParticipationMode => {
    const coupling: Triple = [0, 0, 0];
    let generalizedMass = 0;
    for (let index = 0; index < free.length; index += 1) {
      const weighted = mass[index] * mode.vector[index];
      coupling[free[index] % 3] += weighted;
      generalizedMass += weighted * mode.vector[index];
    }
    const modalMassScale = generalizedMass > 0 && Number.isFinite(generalizedMass) ? Math.sqrt(generalizedMass) : 0;
    const participationFactor = coupling.map((value) => (modalMassScale > 0 ? value / modalMassScale : 0)) as Triple;
    const effectiveMass = coupling.map((value) => (modalMassScale > 0 ? (value * value) / generalizedMass : 0)) as Triple;
    const effectiveMassRatio = effectiveMass.map((value) => (totalMass > 0 ? value / totalMass : 0)) as Triple;
    for (let direction = 0; direction < 3; direction += 1) cumulative[direction] += effectiveMassRatio[direction];
    return {
      modeIndex: mode.modeIndex,
      participationFactor,
      effectiveMass,
      effectiveMassRatio,
      cumulativeEffectiveMassRatio: [...cumulative]
    };
  });
  return {
    massUnits: input.massUnits,
    massMatrix: "lumped",
    totalMass,
    unconstrainedMass,
    computedOnProjectedModel: input.computedOnProjectedModel,
    modes
  };
}

/** Lumped mass carries density × volume, so its unit follows the solver unit system. */
export function solverMassUnits(model: Pick<NormalizedOpenFEAModel, "coordinateSystem">): CoreModalMassParticipation["massUnits"] {
  return model.coordinateSystem.solverUnits === "mm-N-s-MPa" ? "t" : "kg";
}
