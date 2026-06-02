import nodemailer from "nodemailer";
import path from "path";
import { ReportResult } from "./pipeline";

interface EmailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  to: string;
  bcc: string[];
}

// EMAIL_BCC is optional; supports multiple addresses separated by commas.
function parseBcc(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((addr) => addr.trim())
    .filter((addr) => addr.length > 0);
}

function loadEmailConfig(): EmailConfig {
  const required = ["EMAIL_HOST", "EMAIL_PORT", "EMAIL_USER", "EMAIL_PASS", "EMAIL_FROM", "EMAIL_TO"] as const;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing email environment variables: ${missing.join(", ")}.\n` +
        `Set them in .env (local) or as GitHub Secrets (CI).`
    );
  }

  const port = Number(process.env.EMAIL_PORT);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid EMAIL_PORT: ${process.env.EMAIL_PORT}`);
  }

  return {
    host: process.env.EMAIL_HOST!,
    port,
    user: process.env.EMAIL_USER!,
    pass: process.env.EMAIL_PASS!,
    from: process.env.EMAIL_FROM!,
    to: process.env.EMAIL_TO!,
    bcc: parseBcc(process.env.EMAIL_BCC),
  };
}

function fmtChange(pct: number): string {
  return pct >= 0 ? `+${pct.toFixed(2)}%` : `${pct.toFixed(2)}%`;
}

function pickLines(stocks: ReportResult["core"]): string {
  if (stocks.length === 0) return "  —";
  return stocks
    .map(
      (s) =>
        `  • ${s.ticker} – ${s.profile?.name ?? ""} (ציון ${s.finalScore.toFixed(1)}/10${s.price > 0 ? `, ${fmtChange(s.changePercent)}` : ""})`
    )
    .join("\n");
}

function fearGreedTextLines(r: ReportResult): string {
  const fg = r.fearGreed;
  if (!fg) return "🌎 Market Sentiment:\n  Fear & Greed Index unavailable";
  return `🌎 Market Sentiment:
  Fear & Greed Index: ${fg.score}
  Classification: ${fg.classification}
  ${fg.hebrew}`;
}

function buildHebrewTextBody(r: ReportResult, today: string): string {
  return `שלום,

הדוח היומי לתאריך ${today} מצורף.

${fearGreedTextLines(r)}

🏛️ Core Opportunities (חברות גדולות ויציבות):
${pickLines(r.core)}

🌱 Growth Opportunities (חברות צמיחה):
${pickLines(r.growth)}

🎲 Speculative Opportunity:
${pickLines(r.speculative)}

📊 איכות נתונים:
  🟢 Live:        ${r.status.liveCount} קריאות API טריות
  🟡 Cached:      ${r.status.cachedCount} ערכים מהמטמון המקומי
  🔴 Unavailable: ${r.status.missingCount} ערכים לא זמינים
${r.status.rateLimitHit ? "\n⚠️  הופעלה מגבלת ה-API בריצה זו.\n" : ""}
הקבצים המצורפים:
  - daily-stock-report.html  (לפתיחה בדפדפן – מומלץ)
  - daily-stock-report.md    (גרסת טקסט)

—
דוח אוטומטי שנוצר על ידי stock-agent.
המידע הוא למטרות מחקר ולמידה בלבד – אינו ייעוץ השקעות.
`;
}

function buildHebrewHtmlBody(r: ReportResult, today: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const rows = (stocks: ReportResult["core"]) =>
    stocks.length > 0
      ? stocks
          .map(
            (s) =>
              `<li><strong>${esc(s.ticker)}</strong> – ${esc(
                s.profile?.name ?? ""
              )} (ציון ${s.finalScore.toFixed(1)}/10${s.price > 0 ? `, ${esc(fmtChange(s.changePercent))}` : ""})</li>`
          )
          .join("")
      : "<li>—</li>";

  const fg = r.fearGreed;
  const sentimentHtml = fg
    ? `<ul>
    <li><strong>Fear &amp; Greed Index:</strong> ${fg.score}</li>
    <li><strong>Classification:</strong> ${esc(fg.classification)}</li>
    <li>${esc(fg.hebrew)}</li>
  </ul>`
    : `<p>Fear &amp; Greed Index unavailable</p>`;

  return `<div dir="rtl" lang="he" style="font-family:-apple-system,Segoe UI,Heebo,Arial,sans-serif;line-height:1.6;color:#0f172a;">
  <p>שלום,</p>
  <p>הדוח היומי לתאריך <strong>${esc(today)}</strong> מצורף.</p>

  <h3 style="margin:18px 0 6px;color:#1e3a8a;">🌎 Market Sentiment</h3>
  ${sentimentHtml}

  <h3 style="margin:18px 0 6px;color:#1e3a8a;">🏛️ Core Opportunities</h3>
  <ul>${rows(r.core)}</ul>
  <h3 style="margin:18px 0 6px;color:#1e3a8a;">🌱 Growth Opportunities</h3>
  <ul>${rows(r.growth)}</ul>
  <h3 style="margin:18px 0 6px;color:#1e3a8a;">🎲 Speculative Opportunity</h3>
  <ul>${rows(r.speculative)}</ul>

  <h3 style="margin:18px 0 6px;color:#1e3a8a;">📊 איכות נתונים</h3>
  <ul>
    <li>🟢 Live: ${r.status.liveCount} קריאות API טריות</li>
    <li>🟡 Cached: ${r.status.cachedCount} ערכים מהמטמון</li>
    <li>🔴 Unavailable: ${r.status.missingCount} ערכים לא זמינים</li>
  </ul>
  ${
    r.status.rateLimitHit
      ? '<p style="background:#fef3c7;padding:10px 14px;border-radius:8px;color:#92400e;">⚠️ הופעלה מגבלת ה-API של Alpha Vantage בריצה זו.</p>'
      : ""
  }
  <p><strong>קבצים מצורפים:</strong></p>
  <ul>
    <li><code>daily-stock-report.html</code> – לפתיחה בדפדפן (מומלץ)</li>
    <li><code>daily-stock-report.md</code> – גרסת טקסט</li>
  </ul>

  <hr style="border:none;border-top:1px solid #e2e8f0;margin:18px 0;">
  <p style="font-size:12px;color:#64748b;">
    דוח אוטומטי שנוצר על ידי <strong>stock-agent</strong>.<br>
    המידע הוא למטרות מחקר ולמידה בלבד – אינו ייעוץ השקעות.
  </p>
</div>`;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  acceptedBccCount: number;
}

export async function sendDailyEmail(r: ReportResult): Promise<SendResult> {
  const cfg = loadEmailConfig();

  // secure: true for SMTPS (port 465); otherwise STARTTLS upgrade on 587 etc.
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  // Verify connection before sending – clearer error than a generic SMTP failure later.
  try {
    await transporter.verify();
  } catch (err: any) {
    throw new Error(`SMTP connection failed (${cfg.host}:${cfg.port}): ${err.message}`);
  }

  // Log count only — never the actual BCC addresses.
  console.log(`   BCC recipients count: ${cfg.bcc.length}`);

  const today = new Date().toISOString().slice(0, 10);
  const subject = `דוח שוק יומי - ${today}`;

  const info = await transporter.sendMail({
    from: cfg.from,
    to: cfg.to,
    ...(cfg.bcc.length > 0 ? { bcc: cfg.bcc } : {}),
    subject,
    text: buildHebrewTextBody(r, today),
    html: buildHebrewHtmlBody(r, today),
    attachments: [
      {
        filename: "daily-stock-report.html",
        path: path.resolve(r.htmlPath),
        contentType: "text/html; charset=utf-8",
      },
      {
        filename: "daily-stock-report.md",
        path: path.resolve(r.mdPath),
        contentType: "text/markdown; charset=utf-8",
      },
    ],
  });

  // nodemailer reports BCC recipients in accepted/rejected too; drop them so
  // hidden recipients are never surfaced to callers or logs.
  const bccSet = new Set(cfg.bcc.map((a) => a.toLowerCase()));
  const isBcc = (a: unknown) => bccSet.has(String(a).toLowerCase());
  const hideBcc = (list: unknown) =>
    ((list as string[]) ?? []).filter((a) => !isBcc(a));

  const acceptedBccCount = ((info.accepted as string[]) ?? []).filter(isBcc).length;

  return {
    messageId: info.messageId,
    accepted: hideBcc(info.accepted),
    rejected: hideBcc(info.rejected),
    acceptedBccCount,
  };
}
