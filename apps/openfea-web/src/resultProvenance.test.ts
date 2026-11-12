import { describe, expect, test } from "vitest";
import { classifyResultProvenance, type ResultProvenance } from "@openfea/schema";
import { resultTierChip } from "./resultProvenance";

const units = "mm-N-s-MPa" as const;

describe("resultTierChip", () => {
  test("maps each provenance tier to its own label without merging tiers", () => {
    const cases: Array<[ResultProvenance, string, string]> = [
      [{ kind: "opencae_core_fea", solver: "opencae-core-sparse-tet", runnerVersion: "browser-0.2.0", meshSource: "actual_volume_mesh", resultSource: "computed", units } as ResultProvenance, "production_fea", "Computed FEA"],
      [{ kind: "local_estimate", solver: "opencae-core-preview-sdof", solverVersion: "0.1.0", meshSource: "structured_block_proxy", resultSource: "computed_preview", units } as ResultProvenance, "core_preview", "Preview (coarse proxy)"],
      [{ kind: "local_estimate", solver: "opencae-local-heuristic", solverVersion: "0.1.0", meshSource: "actual_volume_mesh", resultSource: "computed", units } as ResultProvenance, "local_estimate", "Estimate — not FEA"],
      [{ kind: "analytical_benchmark", solver: "analytical", solverVersion: "0.1.0", meshSource: "actual_volume_mesh", resultSource: "computed", units } as ResultProvenance, "analytical_benchmark", "Analytical benchmark"],
      [{ kind: "opencae_core_fea", solver: ["cloudflare-fea", "calculix"].join("-"), solverVersion: "0.1.0", meshSource: "actual_volume_mesh", resultSource: "computed", units } as ResultProvenance, "imported_legacy", "Legacy result"]
    ];
    for (const [provenance, tier, label] of cases) {
      expect(classifyResultProvenance(provenance)).toBe(tier);
      expect(resultTierChip(provenance).label).toBe(label);
    }
    expect(resultTierChip(undefined)).toMatchObject({ label: "Unverified source", tone: "unknown" });
  });

  test("only production FEA reads as computed", () => {
    expect(resultTierChip({ kind: "local_estimate", solver: "opencae-local-heuristic", solverVersion: "0.1.0", meshSource: "actual_volume_mesh", resultSource: "computed", units } as ResultProvenance).tone).toBe("approximation");
    expect(resultTierChip({ kind: "opencae_core_fea", solver: "opencae-core-sparse-tet", runnerVersion: "browser-0.2.0", meshSource: "actual_volume_mesh", resultSource: "computed", units } as ResultProvenance).tone).toBe("computed");
  });
});
