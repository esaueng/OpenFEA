/**
 * Per-body material assignment (plan 036 R1.3). A material assignment may name
 * the body it applies to; one without a `bodyId` is the whole-model default
 * and covers every body that has no assignment of its own. Every project
 * saved before per-body materials stores exactly one such default, so it keeps
 * resolving to the same single material.
 */
export type BodyScopedAssignment = { bodyId?: string };

/** Element blocks (and element sets) that carry one body's elements are named `body:<bodyId>`. */
export const BODY_ELEMENT_BLOCK_PREFIX = "body:";

export function bodyElementBlockName(bodyId: string): string {
  return `${BODY_ELEMENT_BLOCK_PREFIX}${bodyId}`;
}

export function bodyIdFromElementBlockName(name: string): string | undefined {
  return name.startsWith(BODY_ELEMENT_BLOCK_PREFIX) && name.length > BODY_ELEMENT_BLOCK_PREFIX.length
    ? name.slice(BODY_ELEMENT_BLOCK_PREFIX.length)
    : undefined;
}

export function hasPerBodyMaterialAssignments(assignments: readonly BodyScopedAssignment[]): boolean {
  return assignments.some((assignment) => typeof assignment.bodyId === "string" && assignment.bodyId.length > 0);
}

/** The body's own assignment, else the whole-model default, else none. */
export function materialAssignmentForBody<T extends BodyScopedAssignment>(assignments: readonly T[], bodyId: string | undefined): T | undefined {
  if (bodyId !== undefined) {
    const own = assignments.find((assignment) => assignment.bodyId === bodyId);
    if (own) return own;
  }
  return assignments.find((assignment) => !assignment.bodyId);
}

/** Viewer STEP bodies are `step-object-<n>` (one-based import order). */
export function bodyLabelForId(bodyId: string): string {
  const match = /^step-object-(\d+)$/.exec(bodyId);
  return match ? `Body ${match[1]}` : bodyId;
}

/**
 * Append `candidate` to a model's material list unless an entry with the same
 * properties already exists, and return the entry to reference. Two bodies can
 * share a catalog id yet differ (e.g. FDM infill), so a name clash with
 * different properties gets a `#<n>` suffix instead of aliasing.
 */
export function addDistinctMaterial<T extends { name: string }>(materials: T[], candidate: T): T {
  const existing = materials.find((material) => sameMaterialProperties(material, candidate));
  if (existing) return existing;
  let name = candidate.name;
  for (let suffix = 2; materials.some((material) => material.name === name); suffix += 1) name = `${candidate.name}#${suffix}`;
  const material = { ...candidate, name };
  materials.push(material);
  return material;
}

function sameMaterialProperties(left: { name: string }, right: { name: string }): boolean {
  const properties = (value: object) => JSON.stringify(
    Object.entries(value).filter(([key, item]) => key !== "name" && item !== undefined).sort(([a], [b]) => a.localeCompare(b))
  );
  return left.name.split("#")[0] === right.name.split("#")[0] && properties(left) === properties(right);
}
