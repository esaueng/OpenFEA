/* Element-quality summary for the Mesh panel (plan 036 R2.1). Display only. */
import { AlertTriangle, Crosshair } from "lucide-react";

import type { MeshQualityMetrics } from "@openfea/schema";

import { formatMeshQualityValue, meshQualityElementLabel, meshQualityMetricRows, type MeshQualityMetricRow } from "../../meshQualityDisplay";

import { Collapsible } from "./PanelChrome";

export function MeshQualityCard({
  quality,
  showWorst,
  onShowWorstChange
}: {
  quality: MeshQualityMetrics;
  showWorst: boolean;
  /** Absent when the viewer cannot highlight elements (no solver mesh to draw them from). */
  onShowWorstChange?: (show: boolean) => void;
}) {
  const rows = meshQualityMetricRows(quality);
  const nonPositive = quality.flagged.tet10NonPositiveDetJ ?? 0;
  const subtitle = quality.flagged.any ? `${quality.flagged.any.toLocaleString()} flagged` : "No elements flagged";
  return (
    <Collapsible title="Element quality" subtitle={subtitle} defaultOpen>
      <section className="mesh-quality-card" aria-label="Element quality">
        <p className="panel-copy">{meshQualityElementLabel(quality)} in the solved mesh. Display only: these checks never block a solve.</p>
        {nonPositive > 0 && (
          <p className="panel-warning" role="alert">
            <AlertTriangle size={16} />
            {nonPositive.toLocaleString()} Tet10 {nonPositive === 1 ? "element has" : "elements have"} det J ≤ 0 at a solver Gauss point; the solver will reject {nonPositive === 1 ? "it" : "them"}.
          </p>
        )}
        <div className="mesh-quality-head" aria-hidden="true">
          <span>Worst</span>
          <span>Worst 5%</span>
          <span>Median</span>
        </div>
        <ul className="mesh-quality-list">
          {rows.map((row) => <MeshQualityRow key={row.key} row={row} />)}
        </ul>
        {onShowWorstChange && quality.worstElements.length > 0 && (
          <button
            type="button"
            className={showWorst ? "primary wide" : "secondary wide"}
            aria-pressed={showWorst}
            onClick={() => onShowWorstChange(!showWorst)}
          >
            <Crosshair size={16} />{showWorst ? "Hide worst elements" : `Show worst ${quality.worstElements.length} elements`}
          </button>
        )}
      </section>
    </Collapsible>
  );
}

function MeshQualityRow({ row }: { row: MeshQualityMetricRow }) {
  return (
    <li className="mesh-quality-row">
      <span className="mesh-quality-name">
        <strong>{row.label}</strong>
        <small>{row.ideal}</small>
      </span>
      <span className="mesh-quality-values" aria-label={`${row.label}: worst ${formatMeshQualityValue(row.stats.worst, row.unit)}, worst 5% ${formatMeshQualityValue(row.stats.p5, row.unit)}, median ${formatMeshQualityValue(row.stats.median, row.unit)}`}>
        <span>{formatMeshQualityValue(row.stats.worst, row.unit)}</span>
        <span>{formatMeshQualityValue(row.stats.p5, row.unit)}</span>
        <span>{formatMeshQualityValue(row.stats.median, row.unit)}</span>
      </span>
      <MeshQualityHistogram row={row} />
      <small className={row.flagged ? "mesh-quality-flag flagged" : "mesh-quality-flag"}>
        {row.flagged.toLocaleString()} {row.thresholdLabel}
      </small>
    </li>
  );
}

const HISTOGRAM_WIDTH = 120;
const HISTOGRAM_HEIGHT = 24;

function MeshQualityHistogram({ row }: { row: MeshQualityMetricRow }) {
  const { counts, min, max } = row.stats.histogram;
  const peak = Math.max(1, ...counts);
  const span = max - min;
  const barWidth = HISTOGRAM_WIDTH / Math.max(1, counts.length);
  const thresholdX = span > 0 ? ((row.threshold - min) / span) * HISTOGRAM_WIDTH : -1;
  const binPastThreshold = (index: number) => {
    const lower = min + index * (span / counts.length);
    const upper = lower + span / counts.length;
    return row.lowerIsWorse ? lower < row.threshold : upper > row.threshold;
  };
  return (
    <svg
      className="mesh-quality-histogram"
      viewBox={`0 0 ${HISTOGRAM_WIDTH} ${HISTOGRAM_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${row.label} histogram, ${counts.length} bins from ${formatMeshQualityValue(min, row.unit)} to ${formatMeshQualityValue(max, row.unit)}; out-of-range values are counted in the end bins`}
    >
      {counts.map((count, index) => {
        // Non-empty bins stay visible even beside a dominant peak.
        const height = count ? Math.max(1.5, (count / peak) * HISTOGRAM_HEIGHT) : 0;
        return (
          <rect
            key={index}
            className={binPastThreshold(index) ? "bar past" : "bar"}
            x={index * barWidth + 0.5}
            y={HISTOGRAM_HEIGHT - height}
            width={Math.max(0.5, barWidth - 1)}
            height={height}
          />
        );
      })}
      {thresholdX >= 0 && thresholdX <= HISTOGRAM_WIDTH && (
        <line className="threshold" x1={thresholdX} x2={thresholdX} y1={0} y2={HISTOGRAM_HEIGHT} />
      )}
    </svg>
  );
}
