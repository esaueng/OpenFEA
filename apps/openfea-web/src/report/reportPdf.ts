import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import regularFontUrl from "./fonts/IBMPlexSans-Regular.ttf?url";
import semiBoldFontUrl from "./fonts/IBMPlexSans-SemiBold.ttf?url";
import type { ReportBoundaryFigure, ReportData, ReportFigure, ReportRow, ReportTable } from "./reportData";
import { REPORT_LAYOUT, REPORT_THEME, REPORT_TYPE } from "./reportTheme";

const FONT_FAMILY = "IBMPlexSans";
const BUILTIN_FONT = "helvetica";
const FOOTER_GAP = 7;
/** Mesh / solver / study lines above the page footer on the cover. */
const COVER_FOOTER_HEIGHT = 15;

let fontAssetsPromise: Promise<{ regular: string; semiBold: string } | null> | null = null;
let logoAssetPromise: Promise<string | null> | null = null;

export async function renderReportPdf(data: ReportData): Promise<Blob> {
  const doc = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: data.pageFormat,
    compress: true,
    putOnlyUsedFonts: true
  });
  const fontFamily = await registerReportFonts(doc);
  const logo = await loadLogo();
  const report = new PdfReport(doc, data, fontFamily);

  report.cover(logo);
  report.modelDefinition();
  report.results();
  report.drawFooters();

  return new Blob([doc.output("arraybuffer")], { type: "application/pdf" });
}

class PdfReport {
  private y: number = REPORT_LAYOUT.margin;
  private readonly pageWidth: number;
  private readonly pageHeight: number;
  private readonly contentWidth: number;

  constructor(
    private readonly doc: jsPDF,
    private readonly data: ReportData,
    private readonly fontFamily: string
  ) {
    this.pageWidth = doc.internal.pageSize.getWidth();
    this.pageHeight = doc.internal.pageSize.getHeight();
    this.contentWidth = this.pageWidth - REPORT_LAYOUT.margin * 2;
  }

  /**
   * Cover order (plan 035 increment 6): brand line → title and one-line context →
   * verdict box → non-production callout → 4-up KPI row under a rule → the primary
   * figure filling what is left → mesh and solver footer.
   */
  cover(logo: string | null): void {
    this.drawBrandHeader(logo);
    this.y = 42;
    this.text(this.data.title, REPORT_LAYOUT.margin, this.y, REPORT_TYPE.title, REPORT_THEME.ink, "bold");
    this.y += 7;
    const context = this.splitText(this.data.coverContext, this.contentWidth, 10.5)[0] ?? this.data.coverContext;
    this.text(context, REPORT_LAYOUT.margin, this.y, 10.5, REPORT_THEME.inkMuted);
    this.y += 7;

    this.verdictBox();
    if (this.data.provenanceTier !== "production_fea") {
      this.callout(this.data.provenanceLabel, "warning", 10);
      this.y += 5;
    }
    this.kpiRow();

    const footerTop = this.pageHeight - REPORT_LAYOUT.footerHeight - COVER_FOOTER_HEIGHT;
    this.figure(this.data.figures.stress, Math.max(42, footerTop - this.y - 2), { fill: true });
    this.coverFooter(footerTop);
  }

  modelDefinition(): void {
    this.addPage();
    this.sectionHeading(1, "Geometry");
    this.keyValueRows(this.data.geometry);
    this.subheading("Geometry files");
    this.table(this.data.geometryFiles);

    this.sectionHeading(2, "Material");
    this.table(this.data.materials);
    this.subheading("Manufacturing");
    this.table(this.data.manufacturing);

    // Keep the heading with the figure: like result figures, the boundary view
    // claims most of the remaining page when it strands below a heading.
    this.sectionHeading(3, "Boundary conditions", this.hasBoundaryFigure() ? 130 : REPORT_LAYOUT.sectionKeepTogether);
    if (this.hasBoundaryFigure()) this.boundaryFigure(this.data.boundaryFigure, 108);
    this.subheading("Supports");
    this.table(this.data.supports);
    this.subheading("Loads");
    this.table(this.data.loads);

    this.sectionHeading(4, "Mesh");
    this.keyValueRows(this.data.mesh);
    if (this.data.meshConvergence) {
      this.subheading("Mesh convergence (coarse → medium → fine)");
      this.table(this.data.meshConvergence);
      if (this.data.meshConvergence.footnote) {
        const lines = this.splitText(this.data.meshConvergence.footnote, this.contentWidth, REPORT_TYPE.caption);
        this.ensureSpace(lines.length * 3.5 + 4);
        this.text(lines, REPORT_LAYOUT.margin, this.y, REPORT_TYPE.caption, REPORT_THEME.inkMuted);
        this.y += lines.length * 3.5 + 5;
      }
    }

    this.sectionHeading(5, "Solver");
    this.keyValueRows(this.data.solver);
  }

  results(): void {
    // Keep the heading with its first figure: a figure claims up to 96mm, so a
    // heading that fits alone in less strands itself above a page break.
    this.sectionHeading(6, "Result figures", 108);
    this.figure(this.data.figures.stress, 82);
    this.ensureSpace(36);
    this.figure(this.data.figures.displacement, 82);

    this.sectionHeading(7, "Results table");
    this.keyValueRows(this.data.results);
    if (this.data.loadCapacity.length) {
      this.subheading("Load capacity (reverse check)");
      this.keyValueRows(this.data.loadCapacity);
      const note = "Estimated by linearly scaling the current result against the material yield limit; verify with a run at the target load.";
      const noteLines = this.splitText(note, this.contentWidth, REPORT_TYPE.caption);
      this.ensureSpace(noteLines.length * 3.5 + 4);
      this.text(noteLines, REPORT_LAYOUT.margin, this.y, REPORT_TYPE.caption, REPORT_THEME.inkMuted);
      this.y += noteLines.length * 3.5 + 5;
    }
    if (this.data.transientResults.length) {
      this.subheading("Transient results");
      this.keyValueRows(this.data.transientResults);
    }

    this.sectionHeading(8, "Diagnostics & limitations");
    const diagnostics = [...this.data.diagnostics];
    if (this.data.includeSmoothingDisclaimer) {
      diagnostics.push("Displayed contours are smoothed for visualization; the summary max stress is the unaveraged element peak.");
    }
    if (!diagnostics.length) diagnostics.push("No active diagnostics were reported for this result.");
    for (const diagnostic of diagnostics) this.bullet(diagnostic);
  }

  drawFooters(): void {
    const pageCount = this.doc.getNumberOfPages();
    for (let page = 1; page <= pageCount; page += 1) {
      this.doc.setPage(page);
      const ruleY = this.pageHeight - REPORT_LAYOUT.footerHeight;
      this.doc.setDrawColor(REPORT_THEME.hairline);
      this.doc.setLineWidth(0.15);
      this.doc.line(REPORT_LAYOUT.margin, ruleY, this.pageWidth - REPORT_LAYOUT.margin, ruleY);
      this.text("Generated by OpenFEA - fea.esau.app", REPORT_LAYOUT.margin, ruleY + 4, REPORT_TYPE.caption, REPORT_THEME.inkMuted);
      this.text(`Page ${page} of ${pageCount}`, this.pageWidth - REPORT_LAYOUT.margin, ruleY + 4, REPORT_TYPE.caption, REPORT_THEME.inkMuted, "normal", "right");
      this.text(this.data.footerDisclaimer, this.pageWidth / 2, ruleY + 7.5, 6.5, REPORT_THEME.inkMuted, "normal", "center");
    }
  }

  private drawBrandHeader(logo: string | null): void {
    if (logo) {
      this.doc.addImage(logo, "PNG", REPORT_LAYOUT.margin, REPORT_LAYOUT.margin - 2, 10, 10, undefined, "FAST");
    } else {
      this.doc.setFillColor(REPORT_THEME.accent);
      this.doc.roundedRect(REPORT_LAYOUT.margin, REPORT_LAYOUT.margin - 2, 10, 10, 1.5, 1.5, "F");
      this.text("O", REPORT_LAYOUT.margin + 5, REPORT_LAYOUT.margin + 5.2, 12, "#ffffff", "bold", "center");
    }
    this.text("OpenFEA", REPORT_LAYOUT.margin + 14, REPORT_LAYOUT.margin + 5.2, 15, REPORT_THEME.ink, "bold");
    this.text(this.data.reportDate, this.pageWidth - REPORT_LAYOUT.margin, REPORT_LAYOUT.margin + 4.2, REPORT_TYPE.body, REPORT_THEME.inkMuted, "normal", "right");
    this.doc.setDrawColor(REPORT_THEME.ink);
    this.doc.setLineWidth(0.5);
    this.doc.line(REPORT_LAYOUT.margin, REPORT_LAYOUT.margin + 11, this.pageWidth - REPORT_LAYOUT.margin, REPORT_LAYOUT.margin + 11);
  }

  /** Keeps `verdictLine()` wording (title — message) inside a tinted box. */
  private verdictBox(): void {
    const assessment = this.data.failureAssessment;
    const color = assessment.status === "pass" ? REPORT_THEME.success : assessment.status === "fail" ? REPORT_THEME.error : REPORT_THEME.warning;
    const fill = assessment.status === "pass" ? REPORT_THEME.successSoft : assessment.status === "fail" ? REPORT_THEME.errorSoft : REPORT_THEME.warningSoft;
    const padX = 4;
    const textX = REPORT_LAYOUT.margin + padX + 4;
    const textWidth = this.contentWidth - (textX - REPORT_LAYOUT.margin) - padX;
    const lineHeight = 4.4;
    this.doc.setFont(this.fontFamily, "bold");
    this.doc.setFontSize(REPORT_TYPE.body);
    const titleWidth = this.doc.getTextWidth(assessment.title);
    const firstLineWidth = textWidth - titleWidth - 2;
    const firstLines = this.splitText(`— ${assessment.message}`, firstLineWidth, REPORT_TYPE.body);
    const restLines = firstLines.length > 1 ? this.splitText(firstLines.slice(1).join(" "), textWidth, REPORT_TYPE.body) : [];
    const height = 7 + (1 + restLines.length) * lineHeight;
    const top = this.y;

    this.doc.setFillColor(fill);
    this.doc.roundedRect(REPORT_LAYOUT.margin, top, this.contentWidth, height, 1.5, 1.5, "F");
    this.doc.setFillColor(color);
    this.doc.rect(REPORT_LAYOUT.margin, top, 1.2, height, "F");
    const baseline = top + 3.5 + lineHeight * 0.8;
    this.doc.circle(REPORT_LAYOUT.margin + padX + 1.2, baseline - 1.2, 1.1, "F");
    this.text(assessment.title, textX, baseline, REPORT_TYPE.body, REPORT_THEME.ink, "bold");
    this.text(firstLines[0] ?? "", textX + titleWidth + 2, baseline, REPORT_TYPE.body, REPORT_THEME.ink);
    if (restLines.length) this.text(restLines, textX, baseline + lineHeight, REPORT_TYPE.body, REPORT_THEME.ink);
    this.y = top + height + 6;
  }

  /** Key results as a 4-up row under a rule; more than four wrap to another row. */
  private kpiRow(): void {
    const rows = this.data.keyResults;
    if (!rows.length) return;
    const perRow = 4;
    const cellWidth = this.contentWidth / perRow;
    const cellHeight = 15;
    this.doc.setDrawColor(REPORT_THEME.ink);
    this.doc.setLineWidth(0.5);
    this.doc.line(REPORT_LAYOUT.margin, this.y, this.pageWidth - REPORT_LAYOUT.margin, this.y);
    for (let start = 0; start < rows.length; start += perRow) {
      const top = this.y;
      rows.slice(start, start + perRow).forEach((row, index) => {
        const x = REPORT_LAYOUT.margin + index * cellWidth;
        if (index > 0) {
          this.doc.setDrawColor(REPORT_THEME.hairline);
          this.doc.setLineWidth(0.2);
          this.doc.line(x - 2, top + 2.5, x - 2, top + cellHeight - 1.5);
        }
        this.text(row.label.toUpperCase(), x, top + 5.5, 6.4, REPORT_THEME.inkMuted);
        // Long values (e.g. "Unit missing") step down rather than run into the next cell.
        const size = this.splitText(row.value, cellWidth - 4, REPORT_TYPE.keyValue, "bold").length > 1 ? 10.5 : REPORT_TYPE.keyValue;
        const value = this.splitText(row.value, cellWidth - 4, size, "bold")[0] ?? row.value;
        this.text(value, x, top + 12.5, size, REPORT_THEME.ink, "bold");
      });
      this.y = top + cellHeight;
    }
    this.doc.setDrawColor(REPORT_THEME.hairline);
    this.doc.setLineWidth(0.2);
    this.doc.line(REPORT_LAYOUT.margin, this.y, this.pageWidth - REPORT_LAYOUT.margin, this.y);
    this.y += 7;
  }

  /** Mesh counts first (what the reader checks), then solver provenance and units. */
  private coverFooter(top: number): void {
    const find = (rows: ReportRow[], label: string) => rows.find((row) => row.label === label)?.value;
    const nodes = find(this.data.mesh, "Nodes");
    const elements = find(this.data.mesh, "Elements");
    const elementType = find(this.data.mesh, "Element type");
    const mesh = [
      nodes && nodes !== "--" ? `${nodes} nodes` : undefined,
      elements && elements !== "--" ? `${elements} elements` : undefined,
      elementType && elementType !== "--" ? elementType : undefined
    ].filter(Boolean).join(" · ") || "Not available (--)";
    const solver = [find(this.data.coverMeta, "Solver"), find(this.data.coverMeta, "Version"), find(this.data.coverMeta, "Method")]
      .filter((value) => value && value !== "--")
      .join(" · ");
    const study = `${this.data.studyName} · ${this.data.unitSystemLabel}`;
    this.doc.setDrawColor(REPORT_THEME.hairline);
    this.doc.setLineWidth(0.2);
    this.doc.line(REPORT_LAYOUT.margin, top, this.pageWidth - REPORT_LAYOUT.margin, top);
    const labelX = REPORT_LAYOUT.margin;
    const valueX = REPORT_LAYOUT.margin + 14;
    const valueWidth = this.contentWidth - 14;
    const lines: Array<[string, string]> = [["MESH", mesh], ["SOLVER", solver || "--"], ["STUDY", study]];
    lines.forEach(([label, value], index) => {
      const y = top + 4.2 + index * 3.6;
      this.text(label, labelX, y, 6.2, REPORT_THEME.inkMuted);
      this.text(this.splitText(value, valueWidth, REPORT_TYPE.caption)[0] ?? value, valueX, y, REPORT_TYPE.caption, REPORT_THEME.ink);
    });
  }

  private sectionHeading(number: number, title: string, keepTogether: number = REPORT_LAYOUT.sectionKeepTogether): void {
    this.ensureSpace(keepTogether);
    this.y += 2;
    this.text(`${number}  ${title}`, REPORT_LAYOUT.margin, this.y, REPORT_TYPE.section, REPORT_THEME.accent, "bold");
    this.y += 3;
    this.doc.setDrawColor(REPORT_THEME.accent);
    this.doc.setLineWidth(0.5);
    this.doc.line(REPORT_LAYOUT.margin, this.y, this.pageWidth - REPORT_LAYOUT.margin, this.y);
    this.y += 6;
  }

  private subheading(title: string): void {
    this.ensureSpace(18);
    this.text(title, REPORT_LAYOUT.margin, this.y, 10, REPORT_THEME.ink, "bold");
    this.y += 4;
  }

  private keyValueRows(rows: ReportRow[]): void {
    this.table({ headers: ["Item", "Value"], rows: rows.map((row) => [row.label, row.value]) });
  }

  private table(table: ReportTable, options: { compact?: boolean; keyResults?: boolean; headerless?: boolean } = {}): void {
    this.ensureSpace(22);
    const rows = table.rows.length ? table.rows : [[table.emptyMessage ?? "Not available (--)", ...table.headers.slice(1).map(() => "--")]];
    autoTable(this.doc, {
      startY: this.y,
      margin: { left: REPORT_LAYOUT.margin, right: REPORT_LAYOUT.margin, bottom: REPORT_LAYOUT.footerHeight + FOOTER_GAP },
      tableWidth: this.contentWidth,
      theme: "plain",
      head: [table.headers],
      body: rows,
      showHead: options.headerless ? false : "everyPage",
      pageBreak: "auto",
      rowPageBreak: "avoid",
      styles: {
        font: this.fontFamily,
        fontStyle: "normal",
        fontSize: options.compact ? 8.6 : REPORT_TYPE.body,
        textColor: REPORT_THEME.ink,
        cellPadding: options.compact ? 1.5 : 2.1,
        lineColor: REPORT_THEME.hairline,
        lineWidth: { bottom: 0.15 },
        valign: "middle",
        overflow: "linebreak"
      },
      headStyles: {
        font: this.fontFamily,
        fontStyle: "bold",
        textColor: REPORT_THEME.accent,
        fillColor: REPORT_THEME.accentSoft,
        lineWidth: { bottom: 0.15 },
        lineColor: REPORT_THEME.hairline
      },
      didParseCell: (hook) => {
        if (!options.keyResults || hook.section !== "body" || hook.column.index !== 1) return;
        hook.cell.styles.fontSize = REPORT_TYPE.keyValue;
        hook.cell.styles.fontStyle = "bold";
      },
      columnStyles: table.headers.length === 2
        ? { 0: { cellWidth: this.contentWidth * 0.38 }, 1: { halign: "right" } }
        : undefined
    });
    const finalY = (this.doc as jsPDF & { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY;
    this.y = (finalY ?? this.y + 18) + 5;
  }

  /**
   * `fill` sizes the frame to all the space it is given (the cover's primary figure)
   * instead of the default 0.56 aspect; the capture is centred in it like a viewport.
   */
  private figure(figure: ReportFigure, maxHeight: number, options: { fill?: boolean } = {}): void {
    if (!options.fill) this.ensureSpace(Math.min(maxHeight + 18, 96));
    this.text(figure.title, REPORT_LAYOUT.margin, this.y, 10, REPORT_THEME.ink, "bold");
    this.y += 4;
    const legendWidth = 24;
    const gap = 5;
    const imageAreaWidth = this.contentWidth - legendWidth - gap;
    const captionHeight = this.splitText(figure.caption, this.contentWidth, REPORT_TYPE.caption).length * 3.5;
    const frameHeight = options.fill
      ? Math.max(35, maxHeight - 4 - 4 - captionHeight)
      : Math.max(35, Math.min(maxHeight - 14, imageAreaWidth * 0.56));
    const imageX = REPORT_LAYOUT.margin;
    const imageY = this.y;

    this.doc.setDrawColor(REPORT_THEME.hairline);
    this.doc.setLineWidth(0.2);
    this.doc.rect(imageX, imageY, imageAreaWidth, frameHeight);
    if (figure.png) {
      const dimensions = pngDimensions(figure.png);
      const fit = fitImage(dimensions.width, dimensions.height, imageAreaWidth - 4, frameHeight - 4);
      this.doc.addImage(
        figure.png,
        "PNG",
        imageX + (imageAreaWidth - fit.width) / 2,
        imageY + (frameHeight - fit.height) / 2,
        fit.width,
        fit.height,
        undefined,
        "FAST"
      );
    } else {
      this.doc.setFillColor("#f6f8fa");
      this.doc.rect(imageX + 0.2, imageY + 0.2, imageAreaWidth - 0.4, frameHeight - 0.4, "F");
      this.text(figure.unavailableLabel, imageX + imageAreaWidth / 2, imageY + frameHeight / 2, REPORT_TYPE.body, REPORT_THEME.inkMuted, "normal", "center");
    }

    this.legend(imageX + imageAreaWidth + gap, imageY, legendWidth, frameHeight, figure);
    this.y += frameHeight + 4;
    const captionLines = this.splitText(figure.caption, this.contentWidth, REPORT_TYPE.caption);
    this.text(captionLines, REPORT_LAYOUT.margin, this.y, REPORT_TYPE.caption, REPORT_THEME.inkMuted);
    this.y += captionLines.length * 3.5 + 6;
  }

  private hasBoundaryFigure(): boolean {
    return Boolean(this.data.boundaryFigure.png || this.data.boundaryFigure.markerKey.length);
  }

  // Full-width viewer snapshot of the support/load markers on the undeformed
  // model; a textual marker key replaces the result figures' color ramp.
  private boundaryFigure(figure: ReportBoundaryFigure, maxHeight: number): void {
    this.ensureSpace(Math.min(maxHeight + 20, 118));
    this.text(figure.title, REPORT_LAYOUT.margin, this.y, 10, REPORT_THEME.ink, "bold");
    this.y += 4;
    // The capture is cropped to its content, so the frame tracks the image's own
    // proportions: a fixed frame would letterbox the model back down to the
    // height it had before the crop.
    const frameHeight = boundaryFrameHeight(figure.png, this.contentWidth, maxHeight);
    const imageX = REPORT_LAYOUT.margin;
    const imageY = this.y;

    this.doc.setDrawColor(REPORT_THEME.hairline);
    this.doc.setLineWidth(0.2);
    this.doc.rect(imageX, imageY, this.contentWidth, frameHeight);
    if (figure.png) {
      const dimensions = pngDimensions(figure.png);
      const fit = fitImage(dimensions.width, dimensions.height, this.contentWidth - 4, frameHeight - 4);
      this.doc.addImage(
        figure.png,
        "PNG",
        imageX + (this.contentWidth - fit.width) / 2,
        imageY + (frameHeight - fit.height) / 2,
        fit.width,
        fit.height,
        undefined,
        "FAST"
      );
    } else {
      this.doc.setFillColor("#f6f8fa");
      this.doc.rect(imageX + 0.2, imageY + 0.2, this.contentWidth - 0.4, frameHeight - 0.4, "F");
      this.text(figure.unavailableLabel, imageX + this.contentWidth / 2, imageY + frameHeight / 2, REPORT_TYPE.body, REPORT_THEME.inkMuted, "normal", "center");
    }
    this.y += frameHeight + 4;

    for (const key of figure.markerKey) {
      const lines = this.splitText(key, this.contentWidth - 4, REPORT_TYPE.caption);
      this.ensureSpace(lines.length * 3.5 + 2);
      this.text(lines, REPORT_LAYOUT.margin + 4, this.y, REPORT_TYPE.caption, REPORT_THEME.ink);
      this.doc.setFillColor(REPORT_THEME.accent);
      this.doc.rect(REPORT_LAYOUT.margin, this.y - 1.5, 2, 0.4, "F");
      this.y += lines.length * 3.5 + 1;
    }
    const captionLines = this.splitText(figure.caption, this.contentWidth, REPORT_TYPE.caption);
    this.ensureSpace(captionLines.length * 3.5 + 4);
    this.text(captionLines, REPORT_LAYOUT.margin, this.y + 1, REPORT_TYPE.caption, REPORT_THEME.inkMuted);
    this.y += captionLines.length * 3.5 + 7;
  }

  private legend(x: number, y: number, width: number, height: number, figure: ReportFigure): void {
    const barWidth = 5;
    const barHeight = Math.max(18, height - 18);
    const segmentHeight = barHeight / REPORT_THEME.ramp.length;
    const barY = y + 8;
    for (let index = 0; index < REPORT_THEME.ramp.length; index += 1) {
      this.doc.setFillColor(REPORT_THEME.ramp[REPORT_THEME.ramp.length - 1 - index]!);
      this.doc.rect(x, barY + index * segmentHeight, barWidth, segmentHeight + 0.1, "F");
    }
    this.doc.setDrawColor(REPORT_THEME.hairline);
    this.doc.rect(x, barY, barWidth, barHeight);
    this.text(figure.legendMax, x + barWidth + 2, barY + 2, 7.2, REPORT_THEME.ink, "bold");
    this.text(figure.legendMin, x + barWidth + 2, barY + barHeight, 7.2, REPORT_THEME.ink, "bold");
    this.text("Max", x, y + 4, 6.8, REPORT_THEME.inkMuted);
    this.text("Min", x, Math.min(y + height, barY + barHeight + 4), 6.8, REPORT_THEME.inkMuted);
    void width;
  }

  private bullet(message: string): void {
    const lines = this.splitText(message, this.contentWidth - 7, REPORT_TYPE.body);
    const height = Math.max(5, lines.length * 4.2);
    this.ensureSpace(height + 2);
    this.doc.setFillColor(REPORT_THEME.accent);
    this.doc.circle(REPORT_LAYOUT.margin + 1.2, this.y - 1, 0.7, "F");
    this.text(lines, REPORT_LAYOUT.margin + 5, this.y, REPORT_TYPE.body, REPORT_THEME.ink);
    this.y += height + 1;
  }

  private callout(message: string | string[], tone: "success" | "warning" | "error", height: number): void {
    const color = tone === "success" ? REPORT_THEME.success : tone === "error" ? REPORT_THEME.error : REPORT_THEME.warning;
    const fill = tone === "success" ? REPORT_THEME.successSoft : tone === "error" ? REPORT_THEME.errorSoft : REPORT_THEME.warningSoft;
    this.doc.setFillColor(fill);
    this.doc.setDrawColor(color);
    this.doc.setLineWidth(0.35);
    this.doc.roundedRect(REPORT_LAYOUT.margin, this.y, this.contentWidth, height, 1.5, 1.5, "FD");
    this.text(message, REPORT_LAYOUT.margin + 4, this.y + 6.2, REPORT_TYPE.body, color, "bold");
    this.y += height;
  }

  private ensureSpace(requiredHeight: number): void {
    if (this.y + requiredHeight <= this.pageHeight - REPORT_LAYOUT.footerHeight - FOOTER_GAP) return;
    this.addPage();
  }

  private addPage(): void {
    this.doc.addPage(this.data.pageFormat, "portrait");
    this.y = REPORT_LAYOUT.margin;
  }

  private splitText(value: string, width: number, size: number, weight: "normal" | "bold" = "normal"): string[] {
    this.doc.setFont(this.fontFamily, weight);
    this.doc.setFontSize(size);
    return this.doc.splitTextToSize(value, width) as string[];
  }

  private text(
    value: string | string[],
    x: number,
    y: number,
    size: number,
    color: string,
    weight: "normal" | "bold" = "normal",
    align: "left" | "center" | "right" = "left"
  ): void {
    this.doc.setFont(this.fontFamily, weight);
    this.doc.setFontSize(size);
    this.doc.setTextColor(color);
    this.doc.text(value, x, y, { align });
  }
}

async function registerReportFonts(doc: jsPDF): Promise<string> {
  try {
    fontAssetsPromise ??= Promise.all([fetchAssetBase64(regularFontUrl), fetchAssetBase64(semiBoldFontUrl)])
      .then(([regular, semiBold]) => ({ regular, semiBold }))
      .catch(() => null);
    const fonts = await fontAssetsPromise;
    if (!fonts) return BUILTIN_FONT;
    doc.addFileToVFS("IBMPlexSans-Regular.ttf", fonts.regular);
    doc.addFont("IBMPlexSans-Regular.ttf", FONT_FAMILY, "normal");
    doc.addFileToVFS("IBMPlexSans-SemiBold.ttf", fonts.semiBold);
    doc.addFont("IBMPlexSans-SemiBold.ttf", FONT_FAMILY, "bold");
    return FONT_FAMILY;
  } catch {
    return BUILTIN_FONT;
  }
}

async function loadLogo(): Promise<string | null> {
  logoAssetPromise ??= fetchAssetBase64("/openfea-logo.png")
    .then((base64) => `data:image/png;base64,${base64}`)
    .catch(() => null);
  return logoAssetPromise;
}

async function fetchAssetBase64(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load report asset: ${url}`);
  return bytesToBase64(new Uint8Array(await response.arrayBuffer()));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function pngDimensions(dataUri: string): { width: number; height: number } {
  try {
    const base64 = dataUri.split(",", 2)[1];
    if (!base64) throw new Error("Missing PNG data");
    const header = atob(base64.slice(0, 40));
    const width = readUint32(header, 16);
    const height = readUint32(header, 20);
    if (width > 0 && height > 0) return { width, height };
  } catch {
    // A malformed capture is handled by jsPDF; this fallback keeps layout deterministic.
  }
  return { width: 1600, height: 900 };
}

function readUint32(binary: string, offset: number): number {
  return (((binary.charCodeAt(offset) << 24) >>> 0) +
    (binary.charCodeAt(offset + 1) << 16) +
    (binary.charCodeAt(offset + 2) << 8) +
    binary.charCodeAt(offset + 3)) >>> 0;
}

const BOUNDARY_FRAME_MIN_HEIGHT = 45;

// Height that lets a content-cropped capture span the full content width, capped
// so the figure still leaves room for its key and the supports/loads tables.
export function boundaryFrameHeight(png: string | undefined, contentWidth: number, maxHeight: number): number {
  const cap = Math.max(BOUNDARY_FRAME_MIN_HEIGHT, maxHeight - 12);
  if (!png) return Math.min(cap, contentWidth * 0.56);
  const { width, height } = pngDimensions(png);
  const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
  return Math.round(clampNumber((contentWidth - 4) / aspect, BOUNDARY_FRAME_MIN_HEIGHT, cap) * 10) / 10;
}

function clampNumber(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}

function fitImage(pixelWidth: number, pixelHeight: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const naturalWidth = pixelWidth / 150 * 25.4;
  const naturalHeight = pixelHeight / 150 * 25.4;
  const scale = Math.min(1, maxWidth / naturalWidth, maxHeight / naturalHeight);
  return {
    width: Math.max(0.2, naturalWidth * scale),
    height: Math.max(0.2, naturalHeight * scale)
  };
}
