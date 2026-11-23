/**
 * Render an `AdminReport` to PDF bytes with pdf-lib.
 *
 * WHY pdf-lib
 * -----------
 * Pure JS, no native deps, no font files to bundle — it runs unchanged in the
 * Next.js Node route, the desktop build and `node --test`. The trade-off is
 * the 14 standard PDF fonts, which only encode WinAnsi (Latin-1). `pdfSafe`
 * maps smart punctuation to ASCII and replaces anything else (Arabic titles,
 * emoji) with "?" so a single exotic project title can never throw mid-render.
 * The FULL report — original Unicode included — is embedded as a JSON file
 * attachment, which is also the best input for an AI assistant.
 *
 * Text-first by design: every chart is accompanied by the table that drew it,
 * because the main consumer is an AI reading extracted text.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import type { Slice, DayPoint } from "../aggregate";
import type { AdminReport, Distribution, FailureGroup, StuckItem, UserActivity } from "./model";
import { SEVERITY_ORDER, type Severity } from "./findings";

// ── Page geometry & palette ─────────────────────────────────────────────────

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN_X = 44;
const MARGIN_TOP = 50;
const MARGIN_BOTTOM = 48;
const CONTENT_W = PAGE_W - MARGIN_X * 2;

const INK = rgb(0.11, 0.12, 0.16);
const MUTED = rgb(0.42, 0.44, 0.5);
const RULE = rgb(0.86, 0.87, 0.9);
const ZEBRA = rgb(0.965, 0.968, 0.98);
const ACCENT = rgb(0.43, 0.3, 0.92);
const ACCENT_SOFT = rgb(0.93, 0.91, 1);

const SEVERITY_COLOR: Record<Severity, RGB> = {
  critical: rgb(0.76, 0.12, 0.16),
  high: rgb(0.85, 0.36, 0.08),
  medium: rgb(0.72, 0.55, 0.02),
  low: rgb(0.2, 0.45, 0.75),
  info: rgb(0.45, 0.47, 0.52),
};

// ── Text safety & formatting ────────────────────────────────────────────────

const REPLACEMENTS: [RegExp, string][] = [
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/[–—−]/g, "-"],
  [/…/g, "..."],
  [/[•·]/g, "-"],
  [/→/g, "->"],
  [/←/g, "<-"],
  [/×/g, "x"],
  [/≥/g, ">="],
  [/≤/g, "<="],
  [/[   ]/g, " "],
  [/[\t\r\n]+/g, " "],
];

/** Make any string encodable by the WinAnsi standard fonts. */
export function pdfSafe(input: unknown): string {
  let s = input == null ? "" : String(input);
  for (const [re, to] of REPLACEMENTS) s = s.replace(re, to);
  // Keep printable ASCII + Latin-1 supplement; everything else → "?".
  return s.replace(/[^\x20-\x7E\xA1-\xFF]/g, "?");
}

const n = (v: number | null | undefined) => (v == null ? "-" : v.toLocaleString("en-US"));
const pctS = (v: number | null | undefined) => (v == null ? "-" : `${v}%`);
const usd = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const dt = (ms: number | null | undefined) =>
  ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "-";
const day = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().slice(0, 10) : "-");

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(1)} s`;
  const m = s / 60;
  if (m < 90) return `${m.toFixed(1)} min`;
  return `${(m / 60).toFixed(1)} h`;
}

export function fmtBytes(b: number | null | undefined): string {
  if (b == null || !Number.isFinite(b) || b <= 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function distRow(label: string, d: Distribution | null, f: (v: number) => string): string[] {
  if (!d) return [label, "-", "-", "-", "-", "-"];
  return [label, n(d.count), f(d.avg), f(d.median), f(d.p90), f(d.max)];
}

// ── Layout engine ───────────────────────────────────────────────────────────

interface Col {
  header: string;
  /** Fraction of the content width. */
  width: number;
  align?: "left" | "right";
}

class Writer {
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];

  readonly doc: PDFDocument;
  readonly regular: PDFFont;
  readonly bold: PDFFont;
  readonly runningTitle: string;

  constructor(doc: PDFDocument, regular: PDFFont, bold: PDFFont, runningTitle: string) {
    this.doc = doc;
    this.regular = regular;
    this.bold = bold;
    this.runningTitle = runningTitle;
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = PAGE_H - MARGIN_TOP;
  }

  ensure(h: number) {
    if (this.y - h < MARGIN_BOTTOM) this.newPage();
  }

  gap(h: number) {
    this.y -= h;
  }

  wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const safe = pdfSafe(text);
    if (!safe) return [""];
    const words = safe.split(" ");
    const lines: string[] = [];
    let line = "";
    const fits = (s: string) => font.widthOfTextAtSize(s, size) <= width;
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (fits(candidate)) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      // Hard-break a single word longer than the line (ids, URLs, signatures).
      let rest = word;
      while (!fits(rest) && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && !fits(rest.slice(0, cut))) cut -= 1;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    if (line) lines.push(line);
    return lines;
  }

  text(
    str: string,
    opts: { size?: number; font?: PDFFont; color?: RGB; indent?: number; after?: number; lineGap?: number } = {}
  ) {
    const size = opts.size ?? 9.5;
    const font = opts.font ?? this.regular;
    const indent = opts.indent ?? 0;
    const lh = size * (opts.lineGap ?? 1.38);
    for (const line of this.wrap(str, font, size, CONTENT_W - indent)) {
      this.ensure(lh);
      this.page.drawText(line, { x: MARGIN_X + indent, y: this.y - size, size, font, color: opts.color ?? INK });
      this.y -= lh;
    }
    this.y -= opts.after ?? 2;
  }

  /** Section heading; `level` 1 starts a new page. */
  heading(str: string, level: 1 | 2 | 3 = 2) {
    if (level === 1) {
      if (this.y < PAGE_H - MARGIN_TOP - 1) this.newPage();
      this.page.drawRectangle({ x: MARGIN_X, y: this.y - 26, width: 4, height: 26, color: ACCENT });
      this.page.drawText(pdfSafe(str), { x: MARGIN_X + 12, y: this.y - 19, size: 17, font: this.bold, color: INK });
      this.y -= 38;
      return;
    }
    const size = level === 2 ? 12.5 : 10.5;
    this.ensure(size * 3.2);
    this.y -= level === 2 ? 10 : 6;
    this.page.drawText(pdfSafe(str), { x: MARGIN_X, y: this.y - size, size, font: this.bold, color: level === 2 ? INK : ACCENT });
    this.y -= size * 1.6;
  }

  note(str: string) {
    this.text(str, { size: 8.5, color: MUTED, after: 4 });
  }

  bullets(items: string[], opts: { size?: number } = {}) {
    const size = opts.size ?? 9.5;
    for (const item of items) {
      const lines = this.wrap(item, this.regular, size, CONTENT_W - 12);
      const lh = size * 1.38;
      lines.forEach((line, i) => {
        this.ensure(lh);
        if (i === 0) this.page.drawText("-", { x: MARGIN_X + 2, y: this.y - size, size, font: this.bold, color: ACCENT });
        this.page.drawText(line, { x: MARGIN_X + 12, y: this.y - size, size, font: this.regular, color: INK });
        this.y -= lh;
      });
      this.y -= 1.5;
    }
    this.y -= 3;
  }

  /** Label/value tiles, `cols` per row. */
  stats(pairs: [string, string][], cols = 4) {
    const gapX = 8;
    const w = (CONTENT_W - gapX * (cols - 1)) / cols;
    const h = 42;
    for (let i = 0; i < pairs.length; i += cols) {
      this.ensure(h + 8);
      pairs.slice(i, i + cols).forEach(([label, value], j) => {
        const x = MARGIN_X + j * (w + gapX);
        this.page.drawRectangle({ x, y: this.y - h, width: w, height: h, color: ZEBRA, borderColor: RULE, borderWidth: 0.6 });
        this.page.drawText(pdfSafe(label.toUpperCase()).slice(0, 40), {
          x: x + 8,
          y: this.y - 13,
          size: 6.8,
          font: this.bold,
          color: MUTED,
        });
        const v = this.wrap(value, this.bold, 13, w - 16)[0] ?? "";
        this.page.drawText(v, { x: x + 8, y: this.y - 32, size: 13, font: this.bold, color: INK });
      });
      this.y -= h + 8;
    }
    this.y -= 2;
  }

  /** A table that wraps cells and repeats its header across page breaks. */
  table(cols: Col[], rows: string[][], opts: { size?: number; empty?: string } = {}) {
    const size = opts.size ?? 7.8;
    const pad = 4;
    const lh = size * 1.3;
    const widths = cols.map((c) => c.width * CONTENT_W);

    const drawHeader = () => {
      const h = lh + pad * 2;
      this.ensure(h + lh * 2 + pad * 2);
      this.page.drawRectangle({ x: MARGIN_X, y: this.y - h, width: CONTENT_W, height: h, color: ACCENT_SOFT });
      let x = MARGIN_X;
      cols.forEach((c, i) => {
        const label = this.wrap(c.header, this.bold, size, widths[i] - pad * 2)[0] ?? "";
        const tx = c.align === "right" ? x + widths[i] - pad - this.bold.widthOfTextAtSize(label, size) : x + pad;
        this.page.drawText(label, { x: tx, y: this.y - pad - size, size, font: this.bold, color: INK });
        x += widths[i];
      });
      this.y -= h;
    };

    if (rows.length === 0) {
      this.text(opts.empty ?? "No data in this window.", { size: 8.5, color: MUTED, after: 6 });
      return;
    }

    drawHeader();
    rows.forEach((row, ri) => {
      const cells = row.map((cell, i) => this.wrap(cell ?? "", this.regular, size, widths[i] - pad * 2));
      const h = Math.max(...cells.map((c) => c.length)) * lh + pad * 2;
      if (this.y - h < MARGIN_BOTTOM) {
        this.newPage();
        drawHeader();
      }
      if (ri % 2 === 1) {
        this.page.drawRectangle({ x: MARGIN_X, y: this.y - h, width: CONTENT_W, height: h, color: ZEBRA });
      }
      let x = MARGIN_X;
      cells.forEach((lines, i) => {
        lines.forEach((line, li) => {
          const tx =
            cols[i].align === "right" ? x + widths[i] - pad - this.regular.widthOfTextAtSize(line, size) : x + pad;
          this.page.drawText(line, { x: tx, y: this.y - pad - size - li * lh, size, font: this.regular, color: INK });
        });
        x += widths[i];
      });
      this.page.drawLine({
        start: { x: MARGIN_X, y: this.y - h },
        end: { x: MARGIN_X + CONTENT_W, y: this.y - h },
        thickness: 0.4,
        color: RULE,
      });
      this.y -= h;
    });
    this.y -= 8;
  }

  /** Two-column label/count table with an inline proportion bar. */
  slices(title: string, data: Slice[], opts: { total?: number; empty?: string } = {}) {
    const total = opts.total ?? data.reduce((s, x) => s + x.value, 0);
    this.heading(title, 3);
    if (data.length === 0) {
      this.text(opts.empty ?? "No data in this window.", { size: 8.5, color: MUTED, after: 6 });
      return;
    }
    const size = 8;
    const lh = 13;
    const labelW = CONTENT_W * 0.45;
    const barX = MARGIN_X + labelW + 70;
    const barW = CONTENT_W - labelW - 70;
    const max = Math.max(1, ...data.map((d) => d.value));
    for (const s of data) {
      this.ensure(lh);
      const label = this.wrap(s.label, this.regular, size, labelW - 6)[0] ?? "";
      this.page.drawText(label, { x: MARGIN_X, y: this.y - size - 1, size, font: this.regular, color: INK });
      const v = `${n(s.value)}${total > 0 ? `  (${((s.value / total) * 100).toFixed(1)}%)` : ""}`;
      this.page.drawText(pdfSafe(v), { x: MARGIN_X + labelW, y: this.y - size - 1, size, font: this.regular, color: MUTED });
      this.page.drawRectangle({ x: barX, y: this.y - 9, width: barW, height: 6, color: ZEBRA });
      if (s.value > 0) {
        this.page.drawRectangle({ x: barX, y: this.y - 9, width: Math.max(1.5, (s.value / max) * barW), height: 6, color: ACCENT });
      }
      this.y -= lh;
    }
    this.y -= 6;
  }

  /** Daily bar chart (the underlying numbers are in the timeline table). */
  bars(title: string, series: DayPoint[]) {
    this.heading(title, 3);
    if (series.length === 0 || series.every((p) => p.count === 0)) {
      this.text("No activity in this window.", { size: 8.5, color: MUTED, after: 6 });
      return;
    }
    const h = 70;
    this.ensure(h + 22);
    const max = Math.max(1, ...series.map((p) => p.count));
    const slot = CONTENT_W / series.length;
    const bw = Math.max(0.8, slot * 0.72);
    const base = this.y - h;
    this.page.drawLine({ start: { x: MARGIN_X, y: base }, end: { x: MARGIN_X + CONTENT_W, y: base }, thickness: 0.5, color: RULE });
    series.forEach((p, i) => {
      if (p.count <= 0) return;
      const bh = (p.count / max) * (h - 8);
      this.page.drawRectangle({ x: MARGIN_X + i * slot + (slot - bw) / 2, y: base, width: bw, height: bh, color: ACCENT });
    });
    this.page.drawText(pdfSafe(`max ${max}/day`), { x: MARGIN_X, y: this.y - 7, size: 6.8, font: this.regular, color: MUTED });
    const first = series[0].day;
    const last = series[series.length - 1].day;
    this.page.drawText(first, { x: MARGIN_X, y: base - 10, size: 6.8, font: this.regular, color: MUTED });
    this.page.drawText(last, {
      x: MARGIN_X + CONTENT_W - this.regular.widthOfTextAtSize(last, 6.8),
      y: base - 10,
      size: 6.8,
      font: this.regular,
      color: MUTED,
    });
    this.y = base - 20;
  }

  /** Header/footer on every page, once the page count is known. */
  finish() {
    const total = this.pages.length;
    this.pages.forEach((p, i) => {
      p.drawLine({ start: { x: MARGIN_X, y: 32 }, end: { x: PAGE_W - MARGIN_X, y: 32 }, thickness: 0.4, color: RULE });
      p.drawText(pdfSafe(this.runningTitle), { x: MARGIN_X, y: 20, size: 7, font: this.regular, color: MUTED });
      const label = `Page ${i + 1} of ${total}`;
      p.drawText(label, {
        x: PAGE_W - MARGIN_X - this.regular.widthOfTextAtSize(label, 7),
        y: 20,
        size: 7,
        font: this.regular,
        color: MUTED,
      });
    });
  }
}

// ── Section renderers ───────────────────────────────────────────────────────

const STUCK_COLS: Col[] = [
  { header: "Kind", width: 0.15 },
  { header: "User", width: 0.2 },
  { header: "Title", width: 0.27 },
  { header: "Status", width: 0.2 },
  { header: "Age", width: 0.18, align: "right" },
];
const stuckRows = (items: StuckItem[]) =>
  items.map((s) => [s.kind, s.user, s.title, s.status, fmtDuration(s.ageMs)]);

const GROUP_COLS: Col[] = [
  { header: "Signature / code", width: 0.34 },
  { header: "Kind", width: 0.14 },
  { header: "Count", width: 0.08, align: "right" },
  { header: "Users", width: 0.08, align: "right" },
  { header: "Last seen", width: 0.13 },
  { header: "Latest sample message", width: 0.23 },
];
const groupRows = (groups: FailureGroup[]) =>
  groups.map((g) => [g.signature, g.kind, n(g.count), n(g.affectedUsers), day(g.lastSeenAt), g.sampleMessage.slice(0, 220)]);

const DIST_COLS: Col[] = [
  { header: "Metric", width: 0.3 },
  { header: "Samples", width: 0.12, align: "right" },
  { header: "Average", width: 0.145, align: "right" },
  { header: "Median", width: 0.145, align: "right" },
  { header: "p90", width: 0.145, align: "right" },
  { header: "Max", width: 0.145, align: "right" },
];

const USER_COLS: Col[] = [
  { header: "User", width: 0.24 },
  { header: "Plan", width: 0.08 },
  { header: "Signed up", width: 0.12 },
  { header: "Last seen", width: 0.12 },
  { header: "Events", width: 0.09, align: "right" },
  { header: "Projects", width: 0.09, align: "right" },
  { header: "Analyses", width: 0.09, align: "right" },
  { header: "Exports", width: 0.08, align: "right" },
  { header: "Failures", width: 0.09, align: "right" },
];
const userRows = (rows: UserActivity[]) =>
  rows.map((u) => [u.user, u.plan, day(u.signedUpAt), day(u.lastSeenAt), n(u.events), n(u.projects), n(u.analyses), n(u.exports), n(u.failures)]);

function renderIntro(w: Writer, r: AdminReport) {
  const page = w.page;
  page.drawRectangle({ x: 0, y: PAGE_H - 150, width: PAGE_W, height: 150, color: ACCENT });
  page.drawText("Framevo", { x: MARGIN_X, y: PAGE_H - 62, size: 13, font: w.bold, color: rgb(1, 1, 1) });
  page.drawText("Admin health & diagnostics report", { x: MARGIN_X, y: PAGE_H - 92, size: 22, font: w.bold, color: rgb(1, 1, 1) });
  page.drawText(pdfSafe(`Window: ${r.meta.window.label}`), { x: MARGIN_X, y: PAGE_H - 116, size: 10, font: w.regular, color: rgb(0.93, 0.92, 1) });
  page.drawText(pdfSafe(`Generated ${dt(r.meta.generatedAt)} by ${r.meta.generatedBy}`), {
    x: MARGIN_X,
    y: PAGE_H - 132,
    size: 8.5,
    font: w.regular,
    color: rgb(0.88, 0.86, 1),
  });
  w.y = PAGE_H - 176;

  w.heading("How to read this report (for AI assistants and reviewers)", 2);
  w.text(
    "Framevo is a web + Windows desktop video editor for screen recordings. Users upload or record a video; an AI analysis (Google Gemini, chunked for videos longer than 90 seconds) detects moments and generates edits such as zooms, cuts, speed-ups, captions and text overlays; users refine them on a timeline and export an MP4. Exports render in the browser (WebCodecs/Editframe, free) or on a paid cloud renderer (Cloud Run). Plans are Free, Pro and Creator, billed through Lemon Squeezy."
  );
  w.text(
    "This document is a point-in-time snapshot taken from the production Firestore database and the app's own analytics events. Section 2 lists rule-based findings (each with the evidence and a recommendation); the later sections hold the underlying numbers. Severity order: critical > high > medium > low > info. A complete machine-readable copy of every number (JSON) is attached to this PDF as 'framevo-admin-report.json'."
  );
  w.text(
    "Suggested prompt: \"You are reviewing the operational report of a SaaS video editor. Using the findings and data below, list the top problems by user impact, explain likely root causes, and propose a prioritized fix plan with concrete engineering and product actions. Call out where the data is insufficient.\"",
    { color: MUTED, size: 9 }
  );
}

function renderSummary(w: Writer, r: AdminReport) {
  const h = r.headline;
  w.heading("1. Executive summary", 2);
  w.stats([
    ["Health score", `${h.healthScore} / 100`],
    ["Total users", n(h.totalUsers)],
    ["New users (window)", n(h.newUsers)],
    ["Active users (window)", n(h.activeUsers)],
    ["Paid users", `${n(h.paidUsers)} (${pctS(h.conversionPct)})`],
    ["List-price MRR", usd(h.listPriceMrr)],
    ["Projects (window)", n(h.projects)],
    ["Chunked analysis jobs", n(h.analysisJobs)],
    ["Exports (window)", n(h.exports)],
    ["Export success", pctS(h.exportSuccessPct)],
    ["Recorded failures", n(h.failures)],
    ["Stuck items", n(h.stuckItems)],
  ]);
  w.note(
    `All time: ${n(r.allTime.users)} users, ${n(r.allTime.projects)} projects, ${n(r.allTime.exports)} exports. Health score = 100 minus a penalty per finding (critical 25, high 12, medium 5, low 2).`
  );
  const counts = SEVERITY_ORDER.map((s) => `${r.findings.filter((f) => f.severity === s).length} ${s}`).join(", ");
  w.text(`Findings: ${counts}.`, { font: w.bold });
  const top = r.findings.filter((f) => f.severity !== "info").slice(0, 6);
  if (top.length) w.bullets(top.map((f) => `[${f.severity.toUpperCase()}] ${f.area}: ${f.title}`));
  else w.text("No problems detected by the rules for this window.", { color: MUTED });
}

function renderFindings(w: Writer, r: AdminReport) {
  w.heading("2. Findings & recommendations", 1);
  w.note("Deterministic rules over the data in this report; every finding cites the numbers that triggered it.");
  r.findings.forEach((f, i) => {
    w.ensure(60);
    const tag = f.severity.toUpperCase();
    const size = 7.5;
    const tw = w.bold.widthOfTextAtSize(tag, size) + 10;
    w.page.drawRectangle({ x: MARGIN_X, y: w.y - 13, width: tw, height: 13, color: SEVERITY_COLOR[f.severity] });
    w.page.drawText(tag, { x: MARGIN_X + 5, y: w.y - 9.5, size, font: w.bold, color: rgb(1, 1, 1) });
    w.page.drawText(pdfSafe(`${i + 1}. ${f.area}`), { x: MARGIN_X + tw + 8, y: w.y - 9.5, size: 8, font: w.bold, color: MUTED });
    w.gap(18);
    w.text(f.title, { font: w.bold, size: 10.5, after: 1 });
    w.text(`Evidence: ${f.evidence}`, { size: 9, indent: 0, after: 1 });
    w.text(`Recommendation: ${f.recommendation}`, { size: 9, color: rgb(0.16, 0.36, 0.22), after: 10 });
  });
}

function renderUsers(w: Writer, r: AdminReport) {
  const u = r.users;
  w.heading("3. Users, growth & activation", 1);
  w.stats([
    ["Total users", n(u.total)],
    ["New in window", n(u.newInRange)],
    ["Active in window", n(u.activeInRange)],
    ["Returning active", n(u.returningActive)],
    ["Paid users", n(u.paid)],
    ["Conversion", pctS(u.conversionPct)],
    ["Paid, inactive", n(u.paidWithoutActivity)],
  ]);
  w.note("Active = emitted at least one production analytics event in the window. Returning = active but signed up before the window.");
  w.slices("Plan distribution (all accounts)", u.byPlan);
  w.bars("Sign-ups per day", u.signupsPerDay);

  w.heading("Activation funnel (users who signed up in the window)", 3);
  const a = u.activation;
  w.table(
    [
      { header: "Step", width: 0.55 },
      { header: "Users", width: 0.2, align: "right" },
      { header: "% of sign-ups", width: 0.25, align: "right" },
    ],
    [
      ["Signed up", n(a.cohort), "100%"],
      ["Created a project", n(a.createdProject), pctS(a.createdProjectPct)],
      ["Got an AI analysis", n(a.analyzed), pctS(a.analyzedPct)],
      ["Exported a video (ready)", n(a.exported), pctS(a.exportedPct)],
    ]
  );

  w.heading("Most active users (user performance)", 3);
  w.note("Ranked by events + 5x projects + 5x exports in the window.");
  w.table(USER_COLS, userRows(u.topUsers));
  w.heading("Users hitting failures", 3);
  w.table(USER_COLS, userRows(u.usersWithFailures), { empty: "No user hit a recorded failure in this window." });
}

function renderProjects(w: Writer, r: AdminReport) {
  const p = r.projects;
  w.heading("4. Projects & uploads", 1);
  w.stats([
    ["Projects (window)", n(p.inRange)],
    ["Never analyzed", n(p.neverAnalyzed)],
    ["Failed", n(p.failed)],
    ["Stuck", n(p.stuck.length)],
    ["Status 'exported'", n(p.statusExported)],
    ["Storage uploaded", fmtBytes(p.totalBytes)],
  ]);
  w.table(DIST_COLS, [
    distRow("Source video length", p.durationSec, (v) => fmtDuration(v * 1000)),
    distRow("Upload file size", p.fileSizeBytes, fmtBytes),
  ]);
  w.slices("Project status", p.byStatus);
  w.slices("Analysis status on project", p.byAnalysisStatus);
  w.slices("Source file types", p.byMimeType);
  w.heading("Stuck projects (non-terminal > 1 h)", 3);
  w.table(STUCK_COLS, stuckRows(p.stuck), { empty: "No stuck projects." });
}

function renderAnalysis(w: Writer, r: AdminReport) {
  const a = r.analysis;
  w.heading("5. AI analysis pipeline", 1);
  w.note("analysisJobs exist only for videos longer than 90 s (chunked). Short videos analyze in place; see project analysis status in section 4.");
  w.stats([
    ["Jobs (window)", n(a.inRange)],
    ["Failure rate", pctS(a.failureRatePct)],
    ["Stuck", n(a.stuck.length)],
    ["Failed chunks", n(a.failedChunksTotal)],
    ["Avg chunks / job", a.avgChunksPerJob == null ? "-" : a.avgChunksPerJob.toFixed(1)],
  ]);
  w.heading("Performance", 3);
  w.table(DIST_COLS, [
    distRow("Processing time (completed jobs)", a.processingMs, fmtDuration),
    distRow("Source video length", a.videoSeconds, (v) => fmtDuration(v * 1000)),
  ]);
  w.slices("Job status", a.byStatus);
  w.slices("Engine", a.byEngine);
  w.slices("Chunk mode", a.byChunkMode);
  w.heading("Analysis failure groups", 3);
  w.table(GROUP_COLS, groupRows(a.failureGroups), { empty: "No failed analysis jobs." });
  w.heading("Stuck analysis jobs", 3);
  w.table(STUCK_COLS, stuckRows(a.stuck), { empty: "No stuck analysis jobs." });
}

function renderExports(w: Writer, r: AdminReport) {
  const x = r.exports;
  w.heading("6. Exports & downloads", 1);
  w.stats([
    ["Exports (window)", n(x.inRange)],
    ["Watermarked", n(x.watermarked)],
    ["Output size", fmtBytes(x.totalBytes)],
    ["Cloud minutes", x.cloudMinutes.toFixed(1)],
    ["Stuck", n(x.stuck.length)],
  ]);
  w.heading("By pipeline", 3);
  w.table(
    [
      { header: "Pipeline", width: 0.13 },
      { header: "Total", width: 0.09, align: "right" },
      { header: "Ready", width: 0.09, align: "right" },
      { header: "Failed", width: 0.09, align: "right" },
      { header: "Cancelled", width: 0.1, align: "right" },
      { header: "In flight", width: 0.1, align: "right" },
      { header: "Fail rate", width: 0.1, align: "right" },
      { header: "Median turnaround", width: 0.15, align: "right" },
      { header: "p90 turnaround", width: 0.15, align: "right" },
    ],
    x.pipelines.map((p) => [
      p.pipeline,
      n(p.total),
      n(p.ready),
      n(p.failed),
      n(p.cancelled),
      n(p.inFlight),
      pctS(p.failureRatePct),
      fmtDuration(p.turnaroundMs?.median),
      fmtDuration(p.turnaroundMs?.p90),
    ])
  );
  w.note("Turnaround = completed minus created (queue + render), ready exports only. Fail rate = failed / (ready + failed).");
  w.slices("Normalized status", x.byStatus);
  w.slices("Raw status per pipeline", x.byRawStatus);
  w.slices("Format", x.byFormat);
  w.slices("Resolution", x.byResolution);
  w.slices("Failed exports by stage", x.failedByStage, { empty: "No failed exports." });
  w.slices("Failed exports by error code", x.byErrorCode, { empty: "No error codes recorded." });
  w.heading("Export failure groups", 3);
  w.table(GROUP_COLS, groupRows(x.failureGroups), { empty: "No failed exports." });
  w.heading("Stuck exports", 3);
  w.table(STUCK_COLS, stuckRows(x.stuck), { empty: "No stuck exports." });
}

function renderFailures(w: Writer, r: AdminReport) {
  const f = r.failures;
  w.heading("7. All recorded failures", 1);
  w.stats([
    ["Failures (window)", n(f.total)],
    ["Users affected", n(f.affectedUsers)],
  ]);
  w.slices("Failures by kind", f.byKind, { empty: "No failures recorded." });
  w.bars("Failures per day", f.perDay);
  w.heading("Top failure signatures (all pipelines)", 3);
  w.note("Messages are normalized (ids, paths, numbers stripped) so repeats of the same bug group together.");
  w.table(GROUP_COLS, groupRows(f.groups), { empty: "No failures recorded." });
  w.heading("Most recent failures", 3);
  w.table(
    [
      { header: "When", width: 0.14 },
      { header: "Kind", width: 0.11 },
      { header: "User", width: 0.14 },
      { header: "Project", width: 0.13 },
      { header: "Message", width: 0.3 },
      { header: "Context", width: 0.18 },
    ],
    f.recent.map((x) => [dt(x.at), x.kind, x.user, x.project, x.code ? `[${x.code}] ${x.message}` : x.message, x.context]),
    { empty: "No failures recorded." }
  );
}

function renderClientSignals(w: Writer, r: AdminReport) {
  const c = r.clientSignals;
  w.heading("8. Client-side reliability & performance", 1);
  w.note("From production analytics events sent by browsers/desktop apps. Complements the server records in sections 5-7.");
  w.heading("Flow outcomes (started -> completed / failed / cancelled)", 3);
  w.table(
    [
      { header: "Flow", width: 0.3 },
      { header: "Started", width: 0.1, align: "right" },
      { header: "Completed", width: 0.12, align: "right" },
      { header: "Failed", width: 0.1, align: "right" },
      { header: "Cancelled", width: 0.11, align: "right" },
      { header: "No outcome", width: 0.12, align: "right" },
      { header: "Success", width: 0.15, align: "right" },
    ],
    c.lifecycles.map((l) => [l.flow, n(l.started), n(l.completed), n(l.failed), n(l.cancelled), n(l.unaccounted), pctS(l.successRatePct)])
  );
  w.heading("Client-reported failure reasons", 3);
  w.table(GROUP_COLS, groupRows(c.failureGroups), { empty: "No *_failed events in this window." });
  w.heading("Timings & sizes reported by clients", 3);
  w.table(
    [
      { header: "Event . field", width: 0.34 },
      { header: "Samples", width: 0.1, align: "right" },
      { header: "Average", width: 0.14, align: "right" },
      { header: "Median", width: 0.14, align: "right" },
      { header: "p90", width: 0.14, align: "right" },
      { header: "Max", width: 0.14, align: "right" },
    ],
    c.perf.map((m) => {
      const f =
        m.unit === "ms"
          ? fmtDuration
          : m.unit === "s"
            ? (v: number) => fmtDuration(v * 1000)
            : m.unit === "bytes"
              ? fmtBytes
              : (v: number) => v.toFixed(1);
      return [`${m.event}.${m.field}`, n(m.stats.count), f(m.stats.avg), f(m.stats.median), f(m.stats.p90), f(m.stats.max)];
    }),
    { empty: "No timing metadata in this window." }
  );
  w.slices("Unsupported browser / edit reports", c.unsupported, { empty: "No 'unsupported' events." });
}

function renderUsage(w: Writer, r: AdminReport) {
  const u = r.usage;
  w.heading("9. Product usage & feature adoption", 1);
  w.stats([
    ["Production events", n(u.productionEvents)],
    ["Distinct active users", n(u.uniqueUsers)],
    ["Non-production events", n(u.otherEnvironmentEvents)],
  ]);
  w.heading("Feature adoption", 3);
  w.table(
    [
      { header: "Feature", width: 0.4 },
      { header: "Users", width: 0.2, align: "right" },
      { header: "% of active users", width: 0.2, align: "right" },
      { header: "Events", width: 0.2, align: "right" },
    ],
    u.features.map((f) => [f.feature, n(f.users), pctS(f.pctOfActive), n(f.events)])
  );
  w.slices("Desktop app funnel", u.desktopFunnel);
  const a = u.assistant;
  w.heading("Editing assistant (chat edits)", 3);
  w.stats([
    ["Requests", n(a.requests)],
    ["Users", n(a.users)],
    ["Applied", pctS(a.appliedPct)],
    ["Undo rate", pctS(a.undoRatePct)],
    ["Jumps to a change", n(a.jumps)],
    ["Model turns", n(a.modelTurns)],
    ["Model failures", n(a.modelFailures)],
    ["Median latency", fmtDuration(a.medianLatencyMs)],
  ]);
  w.slices("Request outcomes", a.byOutcome, { empty: "No assistant requests in this window." });
  w.slices("Understood by", a.bySource, { empty: "No assistant requests in this window." });
  w.slices("Rejection reasons (validator error codes)", a.topErrorCodes, { empty: "No rejected requests." });
  w.slices("Assistant → export funnel (users)", a.funnel);
  w.slices("Events by plan", u.byPlan);
  w.slices("Events by environment", u.byEnvironment);
  w.slices("All events by name (top 40)", u.topEvents);
}

function renderBilling(w: Writer, r: AdminReport) {
  const b = r.billing;
  w.heading("10. Billing & revenue", 1);
  w.stats([
    ["List-price MRR", usd(b.listPriceMrr)],
    ["List-price ARR", usd(b.listPriceArr)],
    ["Access-granting subs", n(b.active)],
    ["Trialing", n(b.trialing)],
    ["Past due", n(b.pastDue)],
    ["Cancelled", n(b.cancelled)],
    ["New subs (window)", n(b.newInRange)],
    ["Plan vs sub gap", n(b.entitlementGap)],
  ]);
  w.note(
    `List prices: ${Object.entries(b.planMonthlyUsd)
      .map(([k, v]) => `${k} ${usd(v)}/mo`)
      .join(", ")}. MRR excludes trials and ignores discounts/taxes. Gap = users with a paid plan (${b.paidPlanUsers}) minus access-granting subscriptions (${b.active}).`
  );
  w.slices("Subscriptions by status", b.byStatus, { empty: "No subscriptions." });
  w.slices("Active subscriptions by plan", b.activeByPlan, { empty: "No active subscriptions." });
  w.heading("At-risk subscriptions", 3);
  w.table(
    [
      { header: "User", width: 0.34 },
      { header: "Plan", width: 0.14 },
      { header: "Status", width: 0.16 },
      { header: "Renews", width: 0.18 },
      { header: "Ends", width: 0.18 },
    ],
    b.atRisk.map((s) => [s.user, s.plan, s.status, day(s.renewsAt), day(s.endsAt)]),
    { empty: "No past-due, unpaid, paused or pending-cancellation subscriptions." }
  );
}

function renderDaily(w: Writer, r: AdminReport) {
  w.heading("11. Day-by-day timeline", 1);
  w.note("UTC days. Failures = analysis + export + failed-project records.");
  const rows = r.daily.filter((d) => d.signups + d.projects + d.analysisJobs + d.exports + d.failures + d.events > 0);
  w.table(
    [
      { header: "Day", width: 0.16 },
      { header: "Sign-ups", width: 0.12, align: "right" },
      { header: "Active users", width: 0.12, align: "right" },
      { header: "Projects", width: 0.12, align: "right" },
      { header: "Analysis jobs", width: 0.12, align: "right" },
      { header: "Exports", width: 0.12, align: "right" },
      { header: "Failures", width: 0.12, align: "right" },
      { header: "Events", width: 0.12, align: "right" },
    ],
    rows.map((d) => [d.day, n(d.signups), n(d.activeUsers), n(d.projects), n(d.analysisJobs), n(d.exports), n(d.failures), n(d.events)]),
    { empty: "No activity in this window." }
  );
}

function renderDataQuality(w: Writer, r: AdminReport) {
  const q = r.dataQuality;
  w.heading("12. Data sources, coverage & blind spots", 1);
  w.table(
    [
      { header: "Source", width: 0.46 },
      { header: "Docs read", width: 0.18, align: "right" },
      { header: "Hit scan cap", width: 0.18, align: "right" },
      { header: "Malformed skipped", width: 0.18, align: "right" },
    ],
    q.sources.map((s) => [s.source, n(s.scanned), s.truncated ? "YES (floor)" : "no", n(s.skipped)])
  );
  w.heading("Caveats an analyst must know", 3);
  w.bullets(q.notes, { size: 9 });
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function renderAdminReportPdf(report: AdminReport): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const generated = new Date(report.meta.generatedAt);
  doc.setTitle(`Framevo admin report - ${pdfSafe(report.meta.window.label)}`);
  doc.setAuthor(pdfSafe(report.meta.generatedBy));
  doc.setSubject("Framevo operational health, usage, failures and performance");
  doc.setKeywords(["Framevo", "admin", "report", "health", "errors", "exports", "analysis", "users"]);
  doc.setCreator("Framevo admin");
  doc.setProducer("Framevo admin report v1 (pdf-lib)");
  doc.setCreationDate(generated);
  doc.setModificationDate(generated);

  const [regular, bold] = await Promise.all([
    doc.embedFont(StandardFonts.Helvetica),
    doc.embedFont(StandardFonts.HelveticaBold),
  ]);
  const w = new Writer(doc, regular, bold, `Framevo admin report - ${report.meta.window.label} - CONFIDENTIAL, internal use`);

  renderIntro(w, report);
  renderSummary(w, report);
  renderFindings(w, report);
  renderUsers(w, report);
  renderProjects(w, report);
  renderAnalysis(w, report);
  renderExports(w, report);
  renderFailures(w, report);
  renderClientSignals(w, report);
  renderUsage(w, report);
  renderBilling(w, report);
  renderDaily(w, report);
  renderDataQuality(w, report);
  w.finish();

  // The complete report, original Unicode included — the best AI input.
  await doc.attach(new TextEncoder().encode(JSON.stringify(report, null, 2)), "framevo-admin-report.json", {
    mimeType: "application/json",
    description: "Complete machine-readable Framevo admin report (every number in this PDF)",
    creationDate: generated,
    modificationDate: generated,
  });

  return doc.save();
}
