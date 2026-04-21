import cron from "node-cron";
import { runValuationRefreshJob } from "./valuation.job";

let isRunning = false;

export function startValuationCron() {
  cron.schedule("0 */6 * * *", async () => {
    if (isRunning) {
      console.log("[valuation.cron] skipped: previous run still active");
      return;
    }

    isRunning = true;

    try {
      console.log("[valuation.cron] starting scheduled valuation refresh");

      const result = await runValuationRefreshJob({
        batchSize: 50,
        concurrency: 3,
        onlyMissing: false,
        log: true
      });

      console.log("[valuation.cron] finished", result);
    } catch (error) {
      console.error("[valuation.cron] failed", error);
    } finally {
      isRunning = false;
    }
  });

  console.log("[valuation.cron] scheduled: every 6 hours");
}