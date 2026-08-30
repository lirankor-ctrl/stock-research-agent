import "dotenv/config";
import { sendDailyEmail } from "./email";
import { generateEmailHtmlBody, generateEmailTextBody } from "./emailBodyGenerator";
import { validatePresentation } from "./presentationValidation";
import { runReport } from "./pipeline";
import { validateReportConsistency } from "./reportValidation";
import { buildReportHealth, formatReportHealth } from "./reportHealth";
import { classifyReportTiming } from "./reportTiming";

// GITHUB_EVENT_NAME is set by the workflow (see .github/workflows/daily-stock-report.yml)
// to "schedule" for the automated pre-market run and "workflow_dispatch" for
// manual/test runs. Locally (no env var at all) we also treat it as manual –
// a developer running `npm run email-report` by hand is never the scheduled
// pre-market send.
const IS_MANUAL_RUN = (process.env.GITHUB_EVENT_NAME ?? "workflow_dispatch") !== "schedule";
const SCHEDULED_HOUR_ISRAEL = Number(process.env.SCHEDULED_HOUR_ISRAEL ?? 16);
const SCHEDULED_MINUTE_ISRAEL = Number(process.env.SCHEDULED_MINUTE_ISRAEL ?? 5);

async function main() {
  console.log("🛠  Generating report...");
  const result = await runReport();

  // Staleness guard – checked right before emailing, using the actual clock
  // at send time (not the workflow's original scheduled time), exactly as
  // required: "before emailing, check the report age". See src/reportTiming.ts
  // for the full decision tree and src/reportHealth.ts for the diagnostics.
  const timing = classifyReportTiming({
    now: new Date(),
    scheduledHourIsrael: SCHEDULED_HOUR_ISRAEL,
    scheduledMinuteIsrael: SCHEDULED_MINUTE_ISRAEL,
    isManualRun: IS_MANUAL_RUN,
  });

  const health = buildReportHealth({ data: result.data, timing, emailSentAtIso: null });
  for (const line of formatReportHealth(health)) console.log(line);

  if (timing.status === "skip") {
    console.warn(`\n⏭️  Skipping email send: ${timing.reasonHebrew}`);
    console.warn("   Report files were still generated and saved under /reports for diagnostics.");
    return;
  }

  // Derived from result.data.generatedAt (the run's single shared
  // timestamp), never a fresh `new Date()` here – the pipeline can take
  // seconds to minutes to run, and a separately-computed "today" is exactly
  // the kind of silent drift that can make the email look stale/different
  // from the attachments it was rendered alongside.
  const today = result.data.generatedAt.slice(0, 10);
  const labelSuffix = timing.status !== "onTime" ? ` [${timing.reportLabel}]` : "";
  const subject = `דוח שוק יומי - ${today}${labelSuffix}`;

  // The email body is rendered from the exact same ReportData object
  // (result.data) that produced the HTML/Markdown attachments – there is no
  // second, independently-decided template.
  const htmlBody = generateEmailHtmlBody(result.data, today);
  const textBody = generateEmailTextBody(result.data, today);

  const violations = [
    ...validateReportConsistency({
      data: result.data,
      htmlAttachment: result.htmlContent,
      mdAttachment: result.mdContent,
      emailHtml: htmlBody,
      emailText: textBody,
    }),
    ...validatePresentation({
      data: result.data,
      htmlAttachment: result.htmlContent,
      emailHtml: htmlBody,
    }),
  ];
  if (violations.length > 0) {
    console.error("\n❌ Report validation failed – refusing to send:");
    for (const v of violations) console.error(`   - ${v}`);
    process.exit(3);
  }
  console.log("✅ Report consistency + presentation validation passed (attachments and email body match).");

  console.log("\n✉️  Sending email...");
  try {
    const sent = await sendDailyEmail({
      subject,
      htmlBody,
      textBody,
      htmlAttachmentPath: result.htmlPath,
      mdAttachmentPath: result.mdPath,
    });
    const emailSentAtIso = new Date().toISOString();
    console.log(`   ✅ Email sent. messageId=${sent.messageId}`);
    if (sent.accepted.length > 0) {
      console.log(`   Accepted main recipients: ${sent.accepted.join(", ")}`);
    }
    console.log(`   Accepted BCC count: ${sent.acceptedBccCount}`);
    if (sent.rejected.length > 0) {
      console.error(`   ⚠️  Rejected: ${sent.rejected.join(", ")}`);
    }
    const finalHealth = buildReportHealth({ data: result.data, timing, emailSentAtIso });
    console.log("");
    for (const line of formatReportHealth(finalHealth)) console.log(line);
  } catch (err: any) {
    console.error(`\n❌ Email send failed: ${err.message ?? err}`);
    console.error(
      "   The report files were still generated and saved under /reports."
    );
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("💥 Fatal error:", err.message ?? err);
  process.exit(1);
});
