import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { Collapsible } from "./PanelChrome";

describe("Collapsible", () => {
  test("keeps the help trigger out of the summary, which is itself a button", () => {
    // axe nested-interactive: a help button inside <summary> merged into the toggle.
    const html = renderToStaticMarkup(<Collapsible title="Reverse check" subtitle="Load for a target safety factor" helpId="targetSafetyFactor">Body</Collapsible>);
    const summary = html.match(/<summary[\s\S]*?<\/summary>/)?.[0] ?? "";
    expect(summary).toContain("Reverse check");
    expect(summary).not.toContain("tooltip-trigger");
    expect(html).toMatch(/^<div class="collapsible-help-anchor"><details class="collapsible-section">[\s\S]*<\/details><span class="collapsible-help">[\s\S]*tooltip-trigger/);
  });

  test("renders a plain details element when there is no help", () => {
    const html = renderToStaticMarkup(<Collapsible title="Display options">Body</Collapsible>);
    expect(html).toMatch(/^<details class="collapsible-section"><summary class="collapsible-summary"><span class="collapsible-title">Display options<\/span>/);
  });
});
