import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { GITHUB_URL, KOFI_URL } from "./KofiLink";
import { PHONE_TOPBAR_QUERY, ProjectMenuLinks, ProjectMenuTools } from "./ProjectMenu";

const projectMenuSource = readFileSync(resolve(__dirname, "ProjectMenu.tsx"), "utf8");

describe("ProjectMenuLinks", () => {
  test("links to Ko-fi and GitHub in new tabs", () => {
    const html = renderToStaticMarkup(<ProjectMenuLinks />);

    expect(html).toContain(`href="${KOFI_URL}"`);
    expect(html).toContain(`href="${GITHUB_URL}"`);
    expect(html).toContain('href="https://ko-fi.com/esau"');
    expect(html).toContain('href="https://github.com/esaueng/OpenFEA"');
    expect(html.match(/target="_blank"/g)).toHaveLength(2);
    expect(html.match(/rel="noreferrer"/g)).toHaveLength(2);
  });

  test("renders the links row inside the open menu, after Theme and Units", () => {
    const unitsRow = projectMenuSource.indexOf('id="project-menu-units"');
    const linksRow = projectMenuSource.indexOf("<ProjectMenuLinks />");
    expect(unitsRow).toBeGreaterThan(0);
    expect(linksRow).toBeGreaterThan(unitsRow);
  });
});

describe("ProjectMenuTools (phone width)", () => {
  const css = readFileSync(resolve(__dirname, "../styles/app.css"), "utf8");
  const workspaceSource = readFileSync(resolve(__dirname, "../WorkspaceApp.tsx"), "utf8");

  test("offers the validation gallery and keyboard guide as named buttons", () => {
    const html = renderToStaticMarkup(<ProjectMenuTools onOpenValidationGallery={vi.fn()} onOpenShortcutGuide={vi.fn()} />);
    expect(html).toContain('role="group" aria-labelledby="project-menu-tools"');
    expect(html).toMatch(/<button type="button" class="secondary">[\s\S]*?Validation gallery<\/button>/);
    expect(html).toMatch(/<button type="button" class="secondary">[\s\S]*?Keyboard shortcuts<\/button>/);
  });

  test("appears only at the width where the top bar drops those buttons", () => {
    expect(PHONE_TOPBAR_QUERY).toBe("(max-width: 640px)");
    expect(projectMenuSource).toContain("const phoneTopbar = useMediaQuery(PHONE_TOPBAR_QUERY);");
    expect(projectMenuSource).toMatch(/\{phoneTopbar && onOpenValidationGallery && onOpenShortcutGuide \? \(\s*<ProjectMenuTools/);
    // Each choice closes the menu before opening its dialog.
    expect(projectMenuSource).toContain("onOpenValidationGallery={() => { setOpen(false); onOpenValidationGallery(); }}");
    expect(projectMenuSource).toContain("onOpenShortcutGuide={() => { setOpen(false); onOpenShortcutGuide(); }}");
    expect(workspaceSource).toContain("onOpenValidationGallery={() => setValidationGalleryOpen(true)}");
    expect(workspaceSource).toContain("onOpenShortcutGuide={() => { setStorageRecoveryNoticeOpen(false); setShortcutGuideOpen(true); }}");
    // The phone rule hides the buttons but not the guide's popover, which the menu now opens.
    const phone = css.slice(css.indexOf("@media (max-width: 640px) {"));
    expect(phone).toContain(".topbar-tools > :not(.history-tools, .shortcut-popover, .shortcut-popover-backdrop) {\n    display: none;");
    // Both popovers pin to the viewport: their anchors no longer reach the bar's right edge.
    expect(phone).toMatch(/\.topbar-tools > \.shortcut-popover,\s*\.project-menu-popover \{\s*position: fixed;/);
    // The sticky top bar sits above the sticky step strip, so the strip cannot cover them.
    expect(css).toMatch(/@media \(max-width: 980px\) \{[\s\S]*?\n  \.topbar \{\s*top: 0;\s*z-index: var\(--z-sticky-topbar\);/);
  });
});
