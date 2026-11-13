import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { VALIDATION_BENCHMARKS, metricAcceptanceLabel } from "./benchmarkRegistry";

const gallerySource = readFileSync(resolve(__dirname, "../components/ValidationGallery.tsx"), "utf8");

describe("metricAcceptanceLabel", () => {
  test("states the tolerance a metric passed or failed against", () => {
    // 45.2 vs 39.06 MPa is a 15.7% error; it passes only because the tolerance is ±35%.
    expect(metricAcceptanceLabel({ id: "root-stress", label: "Peak von Mises", value: 45.2, units: "MPa", reference: 39.06, tolerancePercent: 35 }))
      .toEqual({ text: "Tolerance ±35% · within", within: true });
    expect(metricAcceptanceLabel({ id: "tip", label: "Tip", value: 0.2, units: "mm", reference: 0.1782, tolerancePercent: 3 }))
      .toEqual({ text: "Tolerance ±3% · outside", within: false });
    expect(metricAcceptanceLabel({ id: "time", label: "Solve time", value: 1200, units: "ms" })).toBeNull();
  });

  test("every release-baseline reference metric carries a tolerance to show", () => {
    for (const benchmark of VALIDATION_BENCHMARKS) {
      for (const metric of benchmark.releaseBaseline.metrics) {
        if (metric.reference !== undefined && Math.abs(metric.reference) > 0) expect(metricAcceptanceLabel(metric), `${benchmark.id}/${metric.id}`).not.toBeNull();
      }
    }
    expect(gallerySource).toContain("metricAcceptanceLabel(metric)");
    expect(gallerySource).toContain("validation-metric-tolerance");
  });
});
