import "dotenv/config";
import { sendDailyEmail } from "./email";
import { runReport } from "./pipeline";

async function main() {
  console.log("🛠  Generating report...");
  const result = await runReport();

  console.log("\n✉️  Sending email...");
  try {
    const sent = await sendDailyEmail(result);
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
