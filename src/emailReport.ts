import "dotenv/config";
import { sendDailyEmail } from "./email";
import { generateEmailHtmlBody, generateEmailTextBody } from "./emailBodyGenerator";
import { validatePresentation } from "./presentationValidation";
import { runReport } from "./pipeline";
import { validateReportConsistency } from "./reportValidation";

async function main() {
  console.log("🛠  Generating report...");
  const result = await runReport();

  // Derived from result.data.generatedAt (the run's single shared
  // timestamp), never a fresh `new Date()` here – the pipeline can take
  // seconds to minutes to run, and a separately-computed "today" is exactly
  // the kind of silent drift that can make the email look stale/different
  // from the attachments it was rendered alongside.
  const today = result.data.generatedAt.slice(0, 10);
  const subject = `דוח שוק יומי - ${today}`;

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
    console.log(`   ✅ Email sent. messageId=${sent.messageId}`);
    if (sent.accepted.length > 0) {
      console.log(`   Accepted main recipients: ${sent.accepted.join(", ")}`);
    }
    console.log(`   Accepted BCC count: ${sent.acceptedBccCount}`);
    if (sent.rejected.length > 0) {
      console.error(`   ⚠️  Rejected: ${sent.rejected.join(", ")}`);
    }
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
