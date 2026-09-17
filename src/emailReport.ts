import "dotenv/config";
import { sendDailyEmail } from "./email";
import { generateEmailHtmlBody, generateEmailTextBody } from "./emailBodyGenerator";
import { validatePresentation } from "./presentationValidation";
import { runReport } from "./pipeline";
import { validateReportConsistency } from "./reportValidation";
import { buildReportHealth, formatReportHealth } from "./reportHealth";
import { classifyReportTiming, classifyScheduleLateness, usMarketState } from "./reportTiming";
import { logPhase } from "./runPhases";
import { diagnoseSchedule } from "./scheduleDiagnostics";
import { alreadySentForTradingDate, loadReportState, saveReportState } from "./reportState";
import { usMarketDateIso } from "./dateUtils";

// ===== What counts as a production run =====
//
// IS_PRODUCTION_RUN is computed ONCE, in the workflow, and handed in here. It is
// deliberately not re-derived from GITHUB_EVENT_NAME in two places: the workflow
// also needs the same answer to decide whether to push state back, and two
// independent derivations of "is this production?" is precisely how a test run
// ends up committing to shared state.
//
// Production:  `workflow_dispatch` carrying production_run=true (the authorized
//              external scheduler — a fine-grained PAT with Actions: write, and
//              deliberately WITHOUT Contents: write), plus `schedule` (a
//              production trigger during migration phase 1, a watchdog after).
// Not:         an ordinary manual workflow_dispatch (production_run defaults to
//              false) or any local run — an operator asked for a report right
//              now, so the staleness guard is bypassed and nothing is ever
//              pushed to shared state.
const GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME ?? "workflow_dispatch";
const IS_PRODUCTION_RUN = process.env.IS_PRODUCTION_RUN === "true";
const IS_MANUAL_RUN = !IS_PRODUCTION_RUN;
// The committed state as it exists on origin/main RIGHT NOW, read by the
// workflow with `git fetch` + `git show`. Reading the checked-out copy instead
// would miss a send pushed by a run that started moments earlier.
const COMMITTED_LAST_SENT_TRADING_DATE = process.env.LAST_SENT_TRADING_DATE || null;
// Defaults track the cron in the workflow: 15:58 Israel, chosen so that
// start + the measured ~3 min pipeline lands delivery inside 16:00–16:10.
const SCHEDULED_HOUR_ISRAEL = Number(process.env.SCHEDULED_HOUR_ISRAEL ?? 15);
const SCHEDULED_MINUTE_ISRAEL = Number(process.env.SCHEDULED_MINUTE_ISRAEL ?? 58);

// Set by the workflow at job start, i.e. before generation. Used for the
// schedule-delay metric and the timezone diagnosis; the staleness guard
// itself still uses the real clock at send time.
function parseWorkflowStart(): Date | undefined {
  const raw = process.env.WORKFLOW_STARTED_AT;
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

async function main() {
  const workflowStartedAt = parseWorkflowStart();
  const generationStartedAtIso = new Date().toISOString();

  // ===== Late-start gate (runs BEFORE generation) =====
  //
  // Deliberately the first thing that happens on a scheduled run. The old
  // order generated the whole report and only then asked whether it should be
  // sent, which on a late run burned ~3 minutes of runner time and ~32 Alpha
  // Vantage calls against a 25/day free-tier ceiling to build something that
  // was going to be discarded. Checking the clock costs nothing, so a run
  // GitHub started hours late now dies in under a second.
  //
  // Manual runs are exempt: an operator pressing the button at 22:00 means it.
  const tradingDate = usMarketDateIso(new Date());

  // ===== Duplicate gate (runs before everything, including the clock check) =====
  //
  // Checked first so that BOTH duplicate causes collapse into one clean answer:
  // an external scheduler that fired twice, and the native-cron watchdog running
  // on a day the external scheduler already delivered. Both are "today is
  // already done", neither is an error, and neither should cost a generation.
  if (IS_PRODUCTION_RUN && alreadySentForTradingDate(COMMITTED_LAST_SENT_TRADING_DATE, tradingDate)) {
    const marker = "REPORT SKIPPED — ALREADY SENT FOR THIS TRADING DATE";
    console.warn(`\n⏭️  ${marker}`);
    console.warn(`   תאריך המסחר ${tradingDate} כבר טופל — הדוח נשלח בריצה קודמת ואין צורך בשליחה נוספת.`);
    console.warn("   No report was generated and no email was sent (no API budget was spent).");
    logPhase("DELIVERY_WINDOW", "skipped", `${marker} (${tradingDate})`);
    logPhase("REPORT_GENERATION", "skipped", marker);
    logPhase("EMAIL_SEND", "skipped", marker);
    console.log(`::notice::${marker} — trading date ${tradingDate} was already delivered.`);
    return;
  }

  if (IS_PRODUCTION_RUN && workflowStartedAt) {
    const diag = diagnoseSchedule({
      workflowStartedAt,
      targetHourIsrael: SCHEDULED_HOUR_ISRAEL,
      targetMinuteIsrael: SCHEDULED_MINUTE_ISRAEL,
    });
    console.log(
      `   schedule: started ${diag.startedIsraelDisplay} Israel · ` +
        `delay = ${diag.delayMinutes}min vs target · verdict = ${diag.verdict}` +
        (diag.looksLikeDstDrift ? " · looks like the off-season (DST) cron" : "")
    );

    const lateness = classifyScheduleLateness({
      workflowStartedAt,
      scheduledHourIsrael: SCHEDULED_HOUR_ISRAEL,
      scheduledMinuteIsrael: SCHEDULED_MINUTE_ISRAEL,
    });

    if (lateness.verdict !== "ok") {
      // The exact, greppable marker asked for — one line, in the logs and in
      // the job summary (via reports/run-status.json), so a skipped delivery
      // is never confused with a crash or with a silently-missing email.
      const marker =
        lateness.verdict === "tooLate"
          ? "REPORT SKIPPED — SCHEDULED RUN STARTED TOO LATE"
          : "REPORT SKIPPED — SCHEDULED RUN STARTED TOO EARLY";
      console.warn(`\n⏭️  ${marker}`);
      console.warn(`   ${diag.reasonHebrew}`);
      console.warn("   No report was generated and no email was sent (no API budget was spent).");
      logPhase("DELIVERY_WINDOW", "failed", `${marker} · ${diag.reasonHebrew}`);
      logPhase("REPORT_GENERATION", "skipped", marker);
      logPhase("EMAIL_SEND", "skipped", marker);
      console.warn(`::warning::${marker} (delay ${lateness.delayMinutes}min vs ${SCHEDULED_HOUR_ISRAEL}:${String(SCHEDULED_MINUTE_ISRAEL).padStart(2, "0")} Israel).`);

      // ===== Watchdog alarm =====
      // Getting here means: it is too late to send AND the duplicate gate above
      // did not fire, i.e. NO report went out for this trading date. On the
      // native-cron fallback run that is precisely the "the external scheduler
      // is dead" signal — it is the one condition worth waking you for, and an
      // ::error:: makes GitHub send the workflow-failure notification.
      //
      // Suppressed when the US market is shut, because then there is no report
      // to miss and the silence is correct. Without this check every US market
      // holiday would page you.
      const marketNow = usMarketState(new Date());
      const marketClosedToday = marketNow === "holiday" || marketNow === "weekend";
      if (lateness.verdict === "tooLate" && !marketClosedToday) {
        console.error(
          `::error::NO REPORT WAS DELIVERED for US trading date ${tradingDate}. ` +
            `This run started ${lateness.delayMinutes} min past the ${SCHEDULED_HOUR_ISRAEL}:` +
            `${String(SCHEDULED_MINUTE_ISRAEL).padStart(2, "0")} Israel target, so it refused to send a stale report, ` +
            `and no earlier run recorded a send for today. Check that the external scheduler ` +
            `(cron-job.org → workflow_dispatch with production_run=true) actually fired.`
        );
      }
      // Exit 0 regardless: refusing a stale send is the guard working, not a
      // failure. The ::error:: above is what raises the alarm; the phase records
      // are what carry the distinction.
      return;
    }

    logPhase("DELIVERY_WINDOW", "ok", diag.reasonHebrew);
  }

  console.log("🛠  Generating report...");
  let result;
  try {
    result = await runReport();
  } catch (err: any) {
    logPhase("REPORT_GENERATION", "failed", String(err?.message ?? err));
    throw err;
  }
  logPhase("REPORT_GENERATION", "ok", `report generated at ${result.data.generatedAt}`);

  // Staleness guard – checked right before emailing, using the actual clock
  // at send time (not the workflow's original scheduled time), exactly as
  // required: "before emailing, check the report age". See src/reportTiming.ts
  // for the full decision tree and src/reportHealth.ts for the diagnostics.
  const timing = classifyReportTiming({
    now: new Date(),
    scheduledHourIsrael: SCHEDULED_HOUR_ISRAEL,
    scheduledMinuteIsrael: SCHEDULED_MINUTE_ISRAEL,
    isManualRun: IS_MANUAL_RUN,
    workflowStartedAt,
  });

  const health = buildReportHealth({
    data: result.data,
    timing,
    emailSentAtIso: null,
    workflowStartedAtIso: workflowStartedAt?.toISOString() ?? null,
    generationStartedAtIso,
  });
  for (const line of formatReportHealth(health)) console.log(line);

  if (timing.status === "skip") {
    console.warn(`\n⏭️  Skipping email send: ${timing.reasonHebrew}`);
    console.warn("   Report files were still generated and saved under /reports for diagnostics.");
    // Deliberately exits 0: refusing to mail a stale "pre-market" report is
    // the guard working as intended, not a failure. The phase record is what
    // makes a skipped send distinguishable from a delivered one – an exit
    // code of 0 alone cannot carry that distinction.
    logPhase("EMAIL_SEND", "skipped", timing.reasonHebrew);
    console.warn(`::warning::Email intentionally NOT sent (${timing.reportLabel}) – stale-report guard.`);
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
    logPhase("EMAIL_SEND", "failed", `validation refused send: ${violations.length} violation(s)`);
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
    logPhase("EMAIL_SEND", "ok", `messageId=${sent.messageId} · accepted=${sent.accepted.length} · bcc=${sent.acceptedBccCount}`);

    // Record the send IMMEDIATELY after it succeeds, before anything else can
    // fail. This file is what a later run — on a different runner, possibly
    // triggered by a different scheduler — reads to know today is done.
    // Written only for production runs: a manual/test send must never mark the
    // trading date as delivered, or it would suppress the real report.
    if (IS_PRODUCTION_RUN) {
      saveReportState({
        ...loadReportState(),
        lastSentUsTradingDate: tradingDate,
        lastSentAtIso: emailSentAtIso,
        lastSentMessageId: sent.messageId ?? null,
        lastSentRunId: process.env.GITHUB_RUN_ID ?? null,
        lastSentEvent: GITHUB_EVENT_NAME,
      });
      console.log(`   🔒 Recorded send for US trading date ${tradingDate} (duplicate guard).`);
    }
    const finalHealth = buildReportHealth({
      data: result.data,
      timing,
      emailSentAtIso,
      workflowStartedAtIso: workflowStartedAt?.toISOString() ?? null,
      generationStartedAtIso,
    });
    console.log("");
    for (const line of formatReportHealth(finalHealth)) console.log(line);
  } catch (err: any) {
    console.error(`\n❌ Email send failed: ${err.message ?? err}`);
    console.error(
      "   The report files were still generated and saved under /reports."
    );
    logPhase("EMAIL_SEND", "failed", String(err?.message ?? err));
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("💥 Fatal error:", err.message ?? err);
  process.exit(1);
});
