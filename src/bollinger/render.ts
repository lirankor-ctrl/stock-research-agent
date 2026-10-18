// Renderers for the Bollinger section. The HTML is table-based with inline
// styles only, so the SAME markup is used in the HTML attachment and the
// email body (email clients ignore <style> blocks and flex/grid) – the two
// HTML surfaces are byte-identical for this section by construction.
import { ltr, PALETTE } from "../reportPresentation";
import { BollingerReport } from "./types";
import {
  BOLLINGER_DISCLAIMER,
  BOLLINGER_SUBTITLE,
  BOLLINGER_TITLE,
  BollingerView,
  buildBollingerView,
  NO_PICK_TITLE,
  ViewBlock,
} from "./view";

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const TABLE = `role="presentation" width="100%" cellpadding="0" cellspacing="0"`;
const ACCENT = "#0e7490"; // teal – distinct from the blue Top Opportunities accent

// ===== HTML =====

function chip(label: string, value: string): string {
  return `<td width="33%" style="padding:4px;" valign="top"><table ${TABLE} style="background:${PALETTE.pageBg};border-radius:8px;"><tr><td style="padding:7px 10px;">
    <div style="font-size:10.5px;color:${PALETTE.muted};letter-spacing:.02em;">${esc(label)}</div>
    <div style="font-size:14px;font-weight:700;color:${PALETTE.navy};">${ltr(esc(value))}</div>
  </td></tr></table></td>`;
}

function snapshotGrid(rows: Array<[string, string]>): string {
  const cells = rows.map(([l, v]) => chip(l, v));
  const trs: string[] = [];
  for (let i = 0; i < cells.length; i += 3) {
    trs.push(`<tr>${cells.slice(i, i + 3).join("")}${"<td></td>".repeat(3 - cells.slice(i, i + 3).length)}</tr>`);
  }
  return `<table ${TABLE} style="margin-top:6px;">${trs.join("")}</table>`;
}

const PLAN_COLORS = [PALETTE.blue, PALETTE.red, PALETTE.green, PALETTE.amber];

function planBoxes(rows: Array<[string, string]>): string {
  const boxes = rows.map(
    ([l, v], i) => `<td width="50%" style="padding:4px;" valign="top"><table ${TABLE} style="background:${PALETTE.cardBg};border:1px solid ${PALETTE.border};border-right:4px solid ${PLAN_COLORS[i % 4]};border-radius:8px;"><tr><td style="padding:8px 10px;">
      <div style="font-size:11.5px;font-weight:700;color:${PALETTE.muted};">${esc(l)}</div>
      <div style="font-size:13px;color:${PALETTE.navy};margin-top:2px;">${esc(v)}</div>
    </td></tr></table></td>`
  );
  return `<table ${TABLE} style="margin-top:6px;"><tr>${boxes.slice(0, 2).join("")}</tr><tr>${boxes.slice(2, 4).join("")}</tr></table>`;
}

function blockHtml(b: ViewBlock): string {
  const paras = b.paragraphs.map((p) => `<p style="margin:4px 0;font-size:13px;line-height:1.6;color:${PALETTE.navy};">${esc(p)}</p>`).join("");
  const bullets = b.bullets.length
    ? `<ul style="margin:4px 0;padding-inline-start:18px;font-size:13px;line-height:1.6;color:${PALETTE.navy};">${b.bullets.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
    : "";
  const links = b.links.length
    ? `<ul style="margin:4px 0;padding-inline-start:18px;font-size:13px;line-height:1.6;">${b.links
        .map((l) => `<li><a href="${esc(l.url)}" style="color:${PALETTE.blue};">${ltr(esc(l.title))}</a> <span style="color:${PALETTE.muted};font-size:11.5px;">(${ltr(esc(l.meta))})</span></li>`)
        .join("")}</ul>`
    : "";
  return `<tr><td style="padding:10px 16px 0;"><div style="font-size:13.5px;font-weight:800;color:${ACCENT};">${esc(b.title)}</div>${paras}${bullets}${links}</td></tr>`;
}

function radarHtml(v: BollingerView): string {
  if (v.radar.length === 0) return "";
  const rows = v.radar
    .map(
      (r) => `<tr>${r
        .map((c, i) => `<td style="padding:6px 8px;border-top:1px solid ${PALETTE.border};font-size:12.5px;${i === 0 ? "font-weight:700;" : ""}">${i === 0 || i >= 3 ? ltr(esc(c)) : esc(c)}</td>`)
        .join("")}</tr>`
    )
    .join("");
  return `<tr><td style="padding:12px 16px 0;">
    <div style="font-size:13px;font-weight:800;color:${PALETTE.muted};">📡 על הרדאר – מועמדים נוספים (לא המלצה; "מתהווה" = עדיין לא אות)</div>
    <table ${TABLE} style="margin-top:4px;border-collapse:collapse;">
      <tr style="color:${PALETTE.muted};font-size:11px;"><td style="padding:4px 8px;">Ticker</td><td style="padding:4px 8px;">Setup</td><td style="padding:4px 8px;">סטטוס</td><td style="padding:4px 8px;">Score</td><td style="padding:4px 8px;">Close · RSI</td></tr>
      ${rows}
    </table>
  </td></tr>`;
}

function footerHtml(v: BollingerView): string {
  return `<tr><td style="padding:12px 16px 14px;">
    <div style="font-size:11px;color:${PALETTE.mutedSoft};line-height:1.6;">${esc(v.methodology)}</div>
    <div style="font-size:11px;color:${PALETTE.muted};margin-top:4px;"><strong>${esc(BOLLINGER_DISCLAIMER)}</strong></div>
  </td></tr>`;
}

function scoreHtml(v: BollingerView): string {
  const rows = v.scoreRows
    .map(([l, pts, note]) => `<tr><td style="padding:3px 8px;font-size:12px;">${esc(l)}</td><td style="padding:3px 8px;font-size:12px;font-weight:700;">${ltr(esc(pts))}</td><td style="padding:3px 8px;font-size:11.5px;color:${PALETTE.muted};">${ltr(esc(note))}</td></tr>`)
    .join("");
  const pens = v.penalties.length
    ? `<div style="font-size:11.5px;color:${PALETTE.red};margin-top:4px;">${v.penalties.map((p) => ltr(esc(p))).join("<br>")}</div>`
    : "";
  return `<tr><td style="padding:10px 16px 0;"><div style="font-size:13.5px;font-weight:800;color:${ACCENT};">פירוט הציון (שקוף ודטרמיניסטי)</div>
    <table ${TABLE} style="background:${PALETTE.pageBg};border-radius:8px;margin-top:4px;">${rows}</table>${pens}</td></tr>`;
}

function headerBand(v: BollingerView): string {
  const pill = (text: string, bg: string, fg: string) =>
    `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${bg};color:${fg};font-size:11.5px;font-weight:700;margin:2px 0 2px 4px;">${esc(text)}</span>`;
  return `<tr><td style="background:${PALETTE.navy};background-image:linear-gradient(135deg,${PALETTE.navy} 0%,${ACCENT} 100%);padding:16px;">
    <div style="font-size:11px;letter-spacing:.08em;color:rgba(255,255,255,.75);font-weight:700;">${esc(v.sessionLabel)}</div>
    <table ${TABLE} style="margin-top:6px;"><tr>
      <td valign="top">
        <div style="font-size:28px;font-weight:800;color:#ffffff;line-height:1.1;">${ltr(esc(v.ticker))}</div>
        <div style="font-size:14px;color:#ffffff;margin-top:2px;">${ltr(esc(v.companyName))}</div>
        <div style="font-size:12px;color:rgba(255,255,255,.75);margin-top:2px;">${ltr(esc(v.sectorLine))}</div>
      </td>
      <td valign="top" align="left" style="white-space:nowrap;">
        <div style="display:inline-block;padding:6px 12px;border-radius:12px;background:#ffffff;color:${PALETTE.navy};font-size:18px;font-weight:800;">${ltr(esc(v.score))}</div>
      </td>
    </tr></table>
    <div style="margin-top:8px;">${pill(v.setupLabel ?? "", "rgba(255,255,255,.16)", "#ffffff")}${pill(v.statusLabel ?? "", PALETTE.greenSoft, "#065f46")}</div>
  </td></tr>`;
}

function selectedHtml(v: BollingerView): string {
  return `<table ${TABLE} class="bollinger-card" style="background:${PALETTE.cardBg};border:1px solid ${PALETTE.border};border-radius:14px;overflow:hidden;">
    ${headerBand(v)}
    <tr><td style="padding:10px 16px;background:#f0fdfa;font-size:13px;color:${PALETTE.navy};">${esc(v.priceLine)}${
      v.repeatNote ? `<div style="font-size:12px;color:${PALETTE.amber};margin-top:4px;">↻ ${esc(v.repeatNote)}</div>` : ""
    }</td></tr>
    <tr><td style="padding:10px 12px 0;"><div style="font-size:13.5px;font-weight:800;color:${ACCENT};padding:0 4px;">תמונת מצב טכנית</div>${snapshotGrid(v.snapshot)}</td></tr>
    <tr><td style="padding:10px 12px 0;"><div style="font-size:13.5px;font-weight:800;color:${ACCENT};padding:0 4px;">תוכנית מותנית (לא הוראת קנייה)</div>${planBoxes(v.plan)}</td></tr>
    ${v.blocks.map(blockHtml).join("")}
    ${scoreHtml(v)}
    ${radarHtml(v)}
    ${footerHtml(v)}
  </table>`;
}

function noneHtml(v: BollingerView): string {
  const title = v.kind === "unavailable" ? "Bollinger scan unavailable today" : NO_PICK_TITLE;
  const hebrew = v.kind === "unavailable" ? "סריקת הבולינגר לא הייתה זמינה בריצה זו." : "אין היום הזדמנות בולינגר ברמת ביטחון גבוהה – עדיף לא לבחור מאשר לכפות בחירה.";
  return `<table ${TABLE} class="bollinger-card bollinger-none" style="background:${PALETTE.cardBg};border:1px solid ${PALETTE.border};border-right:4px solid ${PALETTE.amber};border-radius:14px;">
    <tr><td style="padding:14px 16px 0;">
      <div style="font-size:16px;font-weight:800;color:${PALETTE.navy};">${ltr(esc(title))}</div>
      <div style="font-size:13px;color:${PALETTE.navy};margin-top:4px;">${esc(hebrew)}</div>
      ${v.noneReason ? `<div style="font-size:12.5px;color:${PALETTE.muted};margin-top:4px;">${esc(v.noneReason)}</div>` : ""}
    </td></tr>
    ${radarHtml(v)}
    ${footerHtml(v)}
  </table>`;
}

export function renderBollingerHtml(report: BollingerReport): string {
  const v = buildBollingerView(report);
  return `<table ${TABLE} class="bollinger-section" style="margin:0 0 24px;"><tr><td>
    <div style="font-size:19px;font-weight:800;color:${PALETTE.navy};margin:0 0 2px;">${esc(BOLLINGER_TITLE)}</div>
    <div style="font-size:12.5px;color:${PALETTE.muted};margin:0 0 10px;">${esc(BOLLINGER_SUBTITLE)}</div>
    ${v.kind === "selected" ? selectedHtml(v) : noneHtml(v)}
  </td></tr></table>`;
}

// ===== Markdown =====

function blockMd(b: ViewBlock): string {
  const lines = [`**${b.title}**`, ""];
  for (const p of b.paragraphs) lines.push(p, "");
  for (const x of b.bullets) lines.push(`- ${x}`);
  for (const l of b.links) lines.push(`- [${l.title}](${l.url}) — ${l.meta}`);
  return lines.join("\n").trim();
}

function radarMd(v: BollingerView): string {
  if (v.radar.length === 0) return "";
  return [
    `**📡 על הרדאר – מועמדים נוספים (לא המלצה; "מתהווה" = עדיין לא אות)**`,
    "",
    "| Ticker | Setup | סטטוס | Score | Close · RSI |",
    "|---|---|---|---|---|",
    ...v.radar.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

export function renderBollingerMarkdown(report: BollingerReport): string {
  const v = buildBollingerView(report);
  const out: string[] = [`## ${BOLLINGER_TITLE}`, "", `_${BOLLINGER_SUBTITLE}_`, ""];
  if (v.kind === "selected") {
    out.push(
      `### ${v.ticker} — ${v.companyName}`,
      "",
      `**${v.setupLabel}** · ${v.statusLabel} · **Score ${v.score}** · ${v.sectorLine}`,
      "",
      `> ${v.priceLine}`,
      ""
    );
    if (v.repeatNote) out.push(`> ↻ ${v.repeatNote}`, "");
    out.push("**תמונת מצב טכנית**", "", "| מדד | ערך |", "|---|---|", ...v.snapshot.map(([l, x]) => `| ${l} | ${x} |`), "");
    out.push("**תוכנית מותנית (לא הוראת קנייה)**", "", ...v.plan.map(([l, x]) => `- **${l}:** ${x}`), "");
    for (const b of v.blocks) out.push(blockMd(b), "");
    out.push("**פירוט הציון (שקוף ודטרמיניסטי)**", "", "| רכיב | נקודות | הערה |", "|---|---|---|", ...v.scoreRows.map((r) => `| ${r.join(" | ")} |`), "");
    for (const p of v.penalties) out.push(`- ${p}`);
    if (v.penalties.length) out.push("");
  } else {
    out.push(
      `### ${v.kind === "unavailable" ? "Bollinger scan unavailable today" : NO_PICK_TITLE}`,
      "",
      v.kind === "unavailable" ? "סריקת הבולינגר לא הייתה זמינה בריצה זו." : "אין היום הזדמנות בולינגר ברמת ביטחון גבוהה – עדיף לא לבחור מאשר לכפות בחירה.",
      ""
    );
    if (v.noneReason) out.push(v.noneReason, "");
  }
  const radar = radarMd(v);
  if (radar) out.push(radar, "");
  out.push(`<sub>${v.methodology}</sub>`, "", `**${BOLLINGER_DISCLAIMER}**`);
  return out.join("\n");
}

// ===== Plain text (email text body) – compact by design =====

export function renderBollingerText(report: BollingerReport): string {
  const v = buildBollingerView(report);
  const out: string[] = [`${BOLLINGER_TITLE}:`];
  if (v.kind === "selected") {
    out.push(`  ${v.ticker} – ${v.companyName} · ${v.setupLabel} · ${v.statusLabel} · Score ${v.score}`, `  ${v.priceLine}`);
    if (v.repeatNote) out.push(`  ↻ ${v.repeatNote}`);
    out.push(`  ${v.snapshot.map(([l, x]) => `${l} ${x}`).join(" · ")}`);
    for (const [l, x] of v.plan) out.push(`  ${l}: ${x}`);
    const news = v.blocks.find((b) => b.links.length > 0);
    for (const l of news?.links ?? []) out.push(`  • ${l.title} (${l.meta}) ${l.url}`);
    out.push("  (ניתוח מלא – פרופיל, תרחישים, סיכונים וקטליזטורים – בקובץ ה-HTML המצורף)");
  } else {
    out.push(`  ${v.kind === "unavailable" ? "Bollinger scan unavailable today" : NO_PICK_TITLE}`);
    if (v.noneReason) out.push(`  ${v.noneReason}`);
  }
  for (const r of v.radar) out.push(`  📡 ${r[0]} – ${r[1]} · ${r[2]} · ${r[3]}`);
  out.push(`  ${BOLLINGER_DISCLAIMER}`);
  return out.join("\n");
}
