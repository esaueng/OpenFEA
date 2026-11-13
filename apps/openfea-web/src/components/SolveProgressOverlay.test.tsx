import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { SolveProgressOverlay, solvePhaseText } from "./SolveProgressOverlay";

const workspaceSource = readFileSync(resolve(__dirname, "../WorkspaceApp.tsx"), "utf8");

describe("SolveProgressOverlay", () => {
  test("shows phase, percent and Stop, with the phase in a polite live region", () => {
    const html = renderToStaticMarkup(
      <SolveProgressOverlay progress={42.4} phase="Solving OpenFEA Core sparse system (CG iteration 120, residual 1.0e-4)." estimatedRemainingMs={8000} onStop={vi.fn()} />
    );
    expect(html).toContain("Simulating · 42%");
    expect(html).toContain('role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="42"');
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true">Solving OpenFEA Core sparse system.</span>');
    expect(html).toContain("About 8s remaining");
    expect(html).toMatch(/<button class="secondary" type="button">[\s\S]*?Stop<\/button>/);
  });

  test("announces phase changes, not every iteration or frame counter", () => {
    expect(solvePhaseText("Solving OpenFEA Core sparse system (CG iteration 12, residual 1.0e-3).")).toBe(solvePhaseText("Solving OpenFEA Core sparse system (CG iteration 13, residual 9.0e-4)."));
    expect(solvePhaseText("Writing dynamic result frames 3 / 40.")).toBe("Writing dynamic result frames.");
    expect(solvePhaseText("Recovering OpenFEA Core element stresses. About 4s remaining.")).toBe("Recovering OpenFEA Core element stresses.");
    expect(solvePhaseText("")).toBe("Starting simulation.");
  });

  test("is shown over the viewer on every step while a solve runs", () => {
    expect(workspaceSource).toMatch(/\{solverRunning && \(\s*<SolveProgressOverlay progress=\{runProgress\} phase=\{runPhaseMessage\}/);
    expect(workspaceSource).toContain("if (event.message) setRunPhaseMessage(event.message);");
  });
});
