import { runValuationRefreshJob } from "../jobs/valuation.job";

async function main() {
  const userId = process.env.VALUATION_JOB_USER_ID;
  const batchSize = process.env.VALUATION_JOB_BATCH_SIZE
    ? Number(process.env.VALUATION_JOB_BATCH_SIZE)
    : undefined;

  const concurrency = process.env.VALUATION_JOB_CONCURRENCY
    ? Number(process.env.VALUATION_JOB_CONCURRENCY)
    : undefined;

  const onlyMissing =
    process.env.VALUATION_JOB_ONLY_MISSING === "true" ? true : false;

  const result = await runValuationRefreshJob({
    userId,
    batchSize,
    concurrency,
    onlyMissing,
    log: true
  });

  console.log("[valuation.job] finished", result);
}

main()
  .catch((error) => {
    console.error("[valuation.job] fatal error", error);
    process.exit(1);
  })
  .finally(async () => {
    process.exit(0);
  });