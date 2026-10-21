import { useEffect, useState } from "react";
import type { DisplayModel } from "@openfea/schema";
import { bodyLabelForId } from "@openfea/materials";
import type { StepFaceRegistry } from "./stepFaces";

/** One solid body of the loaded model, as the viewer and per-body materials name it. */
export type ModelBody = {
  /** Viewer object id, `step-object-<n>` (one-based STEP import order). */
  id: string;
  label: string;
  /** Zero-based STEP face-registry mesh index. */
  meshIndex: number;
  /** STEP face ids on this body, so a viewer face pick resolves to its body. */
  faceIds: ReadonlySet<string>;
};

/** Bodies with real tessellation; empty placeholder meshes keep their index but are not bodies. */
export function modelBodiesForRegistry(registry: Pick<StepFaceRegistry, "meshes" | "faces">): ModelBody[] {
  return registry.meshes.flatMap((mesh, meshIndex) => {
    if (mesh.positions.length < 9) return [];
    const id = `step-object-${meshIndex + 1}`;
    const faceIds = new Set(registry.faces.filter((face) => face.meshIndex === meshIndex).map((face) => face.faceId));
    return [{ id, label: bodyLabelForId(id), meshIndex, faceIds }];
  });
}

export function bodyIdForFace(bodies: readonly ModelBody[], faceId: string | null | undefined): string | undefined {
  return faceId ? bodies.find((body) => body.faceIds.has(faceId))?.id : undefined;
}

/**
 * Bodies of a STEP model, from the cached face registry (loaded on demand).
 * Other geometry sources are one body and report none, so single-body studies
 * keep the single-material workflow.
 */
export function useModelBodies(displayModel: DisplayModel | null | undefined): ModelBody[] {
  const contentBase64 = displayModel?.nativeCad?.format === "step" ? displayModel.nativeCad.contentBase64 : undefined;
  const [state, setState] = useState<{ key: string | undefined; bodies: ModelBody[] }>({ key: undefined, bodies: [] });
  useEffect(() => {
    if (!contentBase64) return undefined;
    let cancelled = false;
    void import("./stepFaces")
      .then((stepFaces) => stepFaces.peekStepFaceRegistryForBase64(contentBase64) ?? stepFaces.stepFaceRegistryFromBase64(contentBase64))
      .then((registry) => {
        if (!cancelled) setState({ key: contentBase64, bodies: modelBodiesForRegistry(registry) });
      })
      .catch(() => {
        // No registry, no body identity: the model stays single-material.
        if (!cancelled) setState({ key: contentBase64, bodies: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [contentBase64]);
  return contentBase64 && state.key === contentBase64 ? state.bodies : EMPTY_BODIES;
}

const EMPTY_BODIES: ModelBody[] = [];
