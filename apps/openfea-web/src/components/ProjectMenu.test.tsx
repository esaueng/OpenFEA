import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { GITHUB_URL, KOFI_URL } from "./KofiLink";
import { ProjectMenuLinks } from "./ProjectMenu";

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
