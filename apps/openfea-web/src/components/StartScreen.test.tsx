import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RecentProjectsSection, StartSamplesSection, StartScreen } from "./StartScreen";
import { advanceOfflineReadiness, resetOfflineReadinessForTests } from "../lib/offlineStatus";

afterEach(() => {
  resetOfflineReadinessForTests();
});

describe("StartScreen", () => {
  test("links the Esau Engineering credit to the company website", () => {
    const html = renderToStaticMarkup(
      <StartScreen onLoadSample={vi.fn()} onCreateProject={vi.fn()} onOpenProject={vi.fn()} />
    );

    expect(html).toContain('href="https://esauengineering.com/"');
    expect(html).toContain("Built by Esau Engineering");
    expect(html).toContain('href="https://github.com/esaueng/OpenFEA"');
    // Same casing as the workspace status bar's GitHub link.
    expect(html).toContain(">GitHub</a>");
    expect(html).toContain("Runs locally in your browser");
    expect(html).not.toContain("v0.1.0-mvp");
    expect(html).not.toContain("local mode");
  });

  test("claims nothing about offline readiness before the service worker reports it", () => {
    const html = renderToStaticMarkup(
      <StartScreen onLoadSample={vi.fn()} onCreateProject={vi.fn()} onOpenProject={vi.fn()} />
    );

    expect(html).toContain("Runs locally");
    expect(html).not.toContain("Offline-ready");
    expect(html).not.toContain("Preparing offline assets");
  });

  test("shows the caching progress, then Offline-ready, as text in the footer", () => {
    advanceOfflineReadiness("preparing");
    const preparing = renderToStaticMarkup(
      <StartScreen onLoadSample={vi.fn()} onCreateProject={vi.fn()} onOpenProject={vi.fn()} />
    );
    expect(preparing).toContain("Preparing offline assets…");
    expect(preparing).not.toContain("Offline-ready");

    advanceOfflineReadiness("ready");
    const ready = renderToStaticMarkup(
      <StartScreen onLoadSample={vi.fn()} onCreateProject={vi.fn()} onOpenProject={vi.fn()} />
    );
    expect(ready).toContain("Offline-ready");
    expect(ready).not.toContain("Preparing offline assets");
    // A11y: the state is conveyed as text (role=status), never color-only.
    expect(ready).toContain('role="status"');
  });

  test("says nothing misleading when the service worker is unsupported or failed", () => {
    advanceOfflineReadiness("unsupported");
    const html = renderToStaticMarkup(
      <StartScreen onLoadSample={vi.fn()} onCreateProject={vi.fn()} onOpenProject={vi.fn()} />
    );
    expect(html).toContain("Runs locally");
    expect(html).not.toContain("Offline");
  });

  test("leads with the Guided header, three action cards and an inline sample gallery (plan 035, 5)", () => {
    const html = renderToStaticMarkup(
      <StartScreen onLoadSample={vi.fn()} onCreateProject={vi.fn()} onOpenProject={vi.fn()} />
    );

    expect(html).toContain("See how a part bends and where it is stressed — right in your browser. Nothing leaves this device.");
    expect(html).toMatch(/<button class="start-action primary sample-action"[^>]*><span><strong>Try a sample<\/strong>/);
    expect(html).toContain("<strong>New study</strong>");
    expect(html).toContain("<strong>Open a project file</strong>");
    expect(html).toContain("<kbd>N</kbd>");
    expect(html).toContain("<kbd>O</kbd>");
    // The second "sample menu" page is gone: the gallery is on the first screen.
    expect(html).not.toContain("Open sample menu");
    expect(html).not.toContain("Load sample project");
    expect(html).toContain("Bracket Demo");
    expect(html).toContain("Beam Demo");
    expect(html).toContain("Cantilever Demo");
    expect(html).toContain("Static stress");
    expect(html).not.toContain("start-tagline");
  });

  test("renders recent-project open, remove, and clear actions", () => {
    const html = renderToStaticMarkup(
      <RecentProjectsSection
        entries={[{
          id: "recent-1",
          filename: "wing.openfea.json",
          projectName: "Wing Rev B",
          lastOpenedAt: 1,
          handle: { name: "wing.openfea.json", getFile: vi.fn() }
        }]}
        busyId={null}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
        onClear={vi.fn()}
      />
    );

    expect(html).toContain(">Recent</h2>");
    expect(html).toContain("Wing Rev B");
    expect(html).toContain("wing.openfea.json");
    expect(html).toContain("Open");
    expect(html).toContain("Remove");
    expect(html).toContain("Clear list");
    expect(html).toContain('aria-label="Remove Wing Rev B from Recent"');
  });

  test("shows a dashed empty state when there are no recent projects", () => {
    const html = renderToStaticMarkup(
      <RecentProjectsSection entries={[]} busyId={null} onOpen={vi.fn()} onRemove={vi.fn()} onClear={vi.fn()} />
    );

    expect(html).toContain('<p class="recent-projects-empty">Projects you save or open appear here.</p>');
    expect(html).not.toContain("Clear list");
  });
});

describe("StartSamplesSection", () => {
  test("renders the analysis-type control and one-click sample cards", () => {
    const html = renderToStaticMarkup(
      <StartSamplesSection analysisType="modal_analysis" onSelectAnalysisType={vi.fn()} onLoadSample={vi.fn()} />
    );

    expect(html).toContain(">Samples</h2>");
    expect(html).toContain('aria-label="Analysis type"');
    for (const label of ["Static stress", "Dynamic", "Modal", "Thermal"]) expect(html).toContain(`>${label}</button>`);
    expect(html).toMatch(/class="active" type="button" aria-pressed="true">Modal</);
    expect(html).toContain('aria-label="Open Bracket Demo sample"');
    expect(html).toContain('aria-label="Open Beam Demo sample"');
    expect(html).toContain('aria-label="Open Cantilever Demo sample"');
    // Cards open, they do not select, so they carry no pressed state.
    expect(html).not.toMatch(/sample-option-card[^>]*aria-pressed/);
    expect(html).toContain("6 natural modes");
  });

  test("loads the clicked sample on a single click", () => {
    const onLoadSample = vi.fn();
    const section = StartSamplesSection({ analysisType: "static_stress", onSelectAnalysisType: vi.fn(), onLoadSample });
    const grid = section.props.children[1];
    const beamCard = grid.props.children.find((card: { key: string }) => card.key === "plate");
    expect(beamCard.props.openOnClick).toBe(true);
    beamCard.props.onOpen("plate");
    expect(onLoadSample).toHaveBeenCalledWith("plate");
  });

  test("does not fire single-key shortcuts from a focused descendant", () => {
    // The workspace guards its single keys on an editable target, a user preference and
    // any open dialog, with a comment citing WCAG 2.1.4. The start screen fired n and o
    // from anywhere inside <main>, with nothing on screen announcing them.
    const source = readFileSync(resolve(__dirname, "StartScreen.tsx"), "utf8");
    expect(source).toContain("if (event.target !== event.currentTarget) return;");
    const guardIndex = source.indexOf("if (event.target !== event.currentTarget) return;");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(source.indexOf('event.key.toLowerCase() === "n"'));
    expect(guardIndex).toBeLessThan(source.indexOf('event.key.toLowerCase() === "o"'));
  });
});

describe("start screen busy and continue states (2026-09 review D23)", () => {
  test("reads as busy while the workspace chunk loads", () => {
    const html = renderToStaticMarkup(<StartScreen busy onLoadSample={vi.fn()} onCreateProject={vi.fn()} onOpenProject={vi.fn()} />);
    expect(html).toContain("Opening the workspace…");
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<button class="start-action secondary" type="button" disabled=""[^>]*><span><strong>New study<\/strong>/);
    expect(html).toMatch(/aria-label="Open Bracket Demo sample"/);
    expect(html).toMatch(/<button class="sample-option-card[^"]*" type="button" disabled=""/);
  });

  test("offers to continue the project still held after Back to start", () => {
    const html = renderToStaticMarkup(<StartScreen continueProject={{ name: "Bracket Demo", onContinue: vi.fn() }} onLoadSample={vi.fn()} onCreateProject={vi.fn()} onOpenProject={vi.fn()} />);
    expect(html).toContain("Continue Bracket Demo");
    expect(html).toContain("Your last project is still open in this browser");
    // Continue takes the one primary fill; Try a sample steps down.
    expect(html).toMatch(/<button class="start-action secondary sample-action"[^>]*><span><strong>Try a sample/);
    expect(renderToStaticMarkup(<StartScreen onLoadSample={vi.fn()} onCreateProject={vi.fn()} onOpenProject={vi.fn()} />)).not.toContain("Continue ");
  });
});
