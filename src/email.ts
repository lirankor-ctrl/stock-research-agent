import nodemailer from "nodemailer";
import path from "path";

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

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  acceptedBccCount: number;
}

// What to send – the caller (emailReport.ts) is responsible for deciding
// which sections exist and what data they contain, by rendering `htmlBody`
// and `textBody` from the SAME ReportData object used for the attachments
// (see emailBodyGenerator.ts). This module only knows how to send an email:
// it must never build report content itself.
export interface EmailPayload {
  subject: string;
  htmlBody: string;
  textBody: string;
  htmlAttachmentPath: string;
  mdAttachmentPath: string;
}

export async function sendDailyEmail(payload: EmailPayload): Promise<SendResult> {
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

  const info = await transporter.sendMail({
    from: cfg.from,
    to: cfg.to,
    ...(cfg.bcc.length > 0 ? { bcc: cfg.bcc } : {}),
    subject: payload.subject,
    text: payload.textBody,
    html: payload.htmlBody,
    attachments: [
      {
        filename: "daily-stock-report.html",
        path: path.resolve(payload.htmlAttachmentPath),
        contentType: "text/html; charset=utf-8",
      },
      {
        filename: "daily-stock-report.md",
        path: path.resolve(payload.mdAttachmentPath),
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
