// Labels and formatting for the persisted element-quality summary (plan 036
// R2.1), shared by the Mesh panel and the report so both state the same
// thresholds in the same words. The metrics are computed by
// @openfea/core computeTetMeshQuality in the mesh worker.
import type { MeshQualityMetrics } from "@openfea/schema";

type MetricKey = keyof MeshQualityMetrics["metrics"];
type MetricStats = NonNullable<MeshQualityMetrics["metrics"][MetricKey]>;

export type MeshQualityMetricRow = {
  key: MetricKey;
  label: string;
  /** What a perfect element scores, for the label. */
  ideal: string;
  unit: "" | "°";
  stats: MetricStats;
  lowerIsWorse: boolean;
  threshold: number;
  /** e.g. "< 0.2" */
  thresholdLabel: string;
  flagged: number;
};

export function meshQualityMetricRows(quality: MeshQualityMetrics): MeshQualityMetricRow[] {
  const { metrics, flagged, thresholds } = quality;
  const rows: MeshQualityMetricRow[] = [
    {
      key: "scaledJacobian",
      label: "Scaled Jacobian",
      ideal: "1 = regular tet, ≤ 0 inverted",
      unit: "",
      stats: metrics.scaledJacobian,
      lowerIsWorse: true,
      threshold: thresholds.scaledJacobianWarnBelow,
      thresholdLabel: `< ${formatThreshold(thresholds.scaledJacobianWarnBelow, "")}`,
      flagged: flagged.scaledJacobian
    }
  ];
  if (metrics.aspectRatio) {
    rows.push({
      key: "aspectRatio",
      label: "Aspect ratio (R/3r)",
      ideal: "1 = regular tet",
      unit: "",
      stats: metrics.aspectRatio,
      lowerIsWorse: false,
      threshold: thresholds.aspectRatioWarnAbove,
      thresholdLabel: `> ${formatThreshold(thresholds.aspectRatioWarnAbove, "")}`,
      flagged: flagged.aspectRatio
    });
  }
  rows.push(
    {
      key: "minDihedralDeg",
      label: "Min dihedral angle",
      ideal: "70.5° = regular tet",
      unit: "°",
      stats: metrics.minDihedralDeg,
      lowerIsWorse: true,
      threshold: thresholds.minDihedralWarnBelowDeg,
      thresholdLabel: `< ${formatThreshold(thresholds.minDihedralWarnBelowDeg, "°")}`,
      flagged: flagged.minDihedral
    },
    {
      key: "maxDihedralDeg",
      label: "Max dihedral angle",
      ideal: "70.5° = regular tet",
      unit: "°",
      stats: metrics.maxDihedralDeg,
      lowerIsWorse: false,
      threshold: thresholds.maxDihedralWarnAboveDeg,
      thresholdLabel: `> ${formatThreshold(thresholds.maxDihedralWarnAboveDeg, "°")}`,
      flagged: flagged.maxDihedral
    }
  );
  if (metrics.tet10DetJRatio) {
    rows.push({
      key: "tet10DetJRatio",
      label: "Tet10 det J ratio (Gauss points)",
      ideal: "1 = straight-sided, ≤ 0 invalid",
      unit: "",
      stats: metrics.tet10DetJRatio,
      lowerIsWorse: true,
      threshold: thresholds.tet10DetJRatioWarnBelow,
      thresholdLabel: `< ${formatThreshold(thresholds.tet10DetJRatioWarnBelow, "")}`,
      flagged: flagged.tet10DetJRatio ?? 0
    });
  }
  return rows;
}

export function formatMeshQualityValue(value: number, unit: "" | "°"): string {
  if (!Number.isFinite(value)) return "—";
  if (unit === "°") return `${value.toFixed(1)}°`;
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(Math.abs(value) >= 10 ? 1 : 3);
}

/** Thresholds are round numbers; show them as written (0.2, 3, 10°). */
function formatThreshold(value: number, unit: "" | "°"): string {
  return `${Number(value.toPrecision(4))}${unit}`;
}

/** "Worst / worst 5% / median" in one string, for compact tables. */
export function formatMeshQualityStats(row: Pick<MeshQualityMetricRow, "stats" | "unit">): string {
  return [row.stats.worst, row.stats.p5, row.stats.median].map((value) => formatMeshQualityValue(value, row.unit)).join(" / ");
}

export function meshQualityElementLabel(quality: MeshQualityMetrics): string {
  return `${quality.elementCount.toLocaleString()} ${quality.elementType} elements`;
}

/** Key/value rows for the report's mesh section. */
export function meshQualityReportRows(quality: MeshQualityMetrics): Array<{ label: string; value: string }> {
  const rows = meshQualityMetricRows(quality).map((row) => ({
    label: `${row.label} — worst / worst 5% / median`,
    value: `${formatMeshQualityStats(row)} (${row.flagged.toLocaleString()} ${row.thresholdLabel})`
  }));
  if (quality.flagged.tet10NonPositiveDetJ !== undefined) {
    rows.push({ label: "Tet10 det J ≤ 0 at a Gauss point", value: quality.flagged.tet10NonPositiveDetJ.toLocaleString() });
  }
  if (quality.degenerateCount) {
    rows.push({ label: "Zero-volume elements", value: quality.degenerateCount.toLocaleString() });
  }
  rows.push({
    label: "Elements past any quality threshold",
    value: `${quality.flagged.any.toLocaleString()} of ${quality.elementCount.toLocaleString()} (display only; thresholds are OpenFEA warning levels and do not block solving)`
  });
  return rows;
}
