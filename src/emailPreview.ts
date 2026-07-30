// Development-only: renders the exact email body that `npm run email-report`
// would send, without sending it. Reuses the same pipeline + email-body
// renderer, so what you see here IS what production would send – never a
// separate mock or fixture.
//
//   npm run email:preview
import fs from "fs";
import path from "path";
import "dotenv/config";
import { generateEmailHtmlBody, generateEmailTextBody } from "./emailBodyGenerator";
import { validatePresentation } from "./presentationValidation";
import { runReport } from "./pipeline";
import { validateReportConsistency } from "./reportValidation";

async function main() {
  console.log("🛠  Generating report (preview only – no email will be sent)...");
  const result = await runReport();

  const today = new Date().toISOString().slice(0, 10);
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
    console.error("\n❌ Report validation failed:");
    for (const v of violations) console.error(`   - ${v}`);
    process.exitCode = 1;
  } else {
    console.log("✅ Report consistency + presentation validation passed.");
  }

  const outDir = path.resolve(process.cwd(), "reports");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "email-preview.html");
  // Wrap the email-body fragment in a minimal standalone page so it can be
  // opened directly in a browser, same as the HTML report attachment.
  const page = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <title>Email preview – דוח שוק יומי - ${today}</title>
</head>
<body style="margin:0;padding:24px;background:#f8fafc;">
${htmlBody}
</body>
</html>`;
  fs.writeFileSync(outPath, page, "utf8");
  console.log(`\n📧 Email preview written to: ${outPath}`);
  console.log("   (Not sent – this command never calls sendDailyEmail.)");
}

main().catch((err) => {
  console.error("💥 Fatal error:", err.message ?? err);
  process.exit(1);
});
