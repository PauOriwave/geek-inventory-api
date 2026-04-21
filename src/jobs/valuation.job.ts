import prisma from "../prisma/client";
import {
  needsValuationRefresh,
  refreshValuation
} from "../valuation/valuation.service";

type RunValuationRefreshJobOptions = {
  userId?: string;
  batchSize?: number;
  concurrency?: number;
  onlyMissing?: boolean;
  log?: boolean;
};

type RunValuationRefreshJobResult = {
  scanned: number;
  queued: number;
  refreshed: number;
  skipped: number;
  failed: number;
};

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_CONCURRENCY = 3;

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
) {
  const queue = [...items];
  const workers = Array.from({
    length: Math.max(1, concurrency)
  }).map(async () => {
    while (queue.length > 0) {
      const item = queue.shift();

      if (!item) {
        return;
      }

      await worker(item);
    }
  });

  await Promise.all(workers);
}

export async function runValuationRefreshJob(
  options: RunValuationRefreshJobOptions = {}
): Promise<RunValuationRefreshJobResult> {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const onlyMissing = options.onlyMissing ?? false;
  const log = options.log ?? true;

  let scanned = 0;
  let queued = 0;
  let refreshed = 0;
  let skipped = 0;
  let failed = 0;

  let cursor: string | undefined;

  while (true) {
    const items = await prisma.item.findMany({
      where: {
        ...(options.userId ? { userId: options.userId } : {}),
        ...(onlyMissing ? { marketValue: null } : {})
      },
      orderBy: {
        id: "asc"
      },
      take: batchSize,
      ...(cursor
        ? {
            skip: 1,
            cursor: { id: cursor }
          }
        : {})
    });

    if (items.length === 0) {
      break;
    }

    scanned += items.length;

    const candidates: typeof items = [];

    for (const item of items) {
      const shouldRefresh = await needsValuationRefresh(item);

      if (!shouldRefresh) {
        skipped++;
        continue;
      }

      candidates.push(item);
    }

    queued += candidates.length;

    await runWithConcurrency(candidates, concurrency, async (item) => {
      try {
        const valuation = await refreshValuation(item);

        if (valuation) {
          refreshed++;
        } else {
          skipped++;
        }
      } catch (error) {
        failed++;
        console.error(
          `[valuation.job] refresh failed for item ${item.id}:`,
          error
        );
      }
    });

    cursor = items[items.length - 1]?.id;

    if (log) {
      console.log("[valuation.job] batch processed", {
        scanned,
        queued,
        refreshed,
        skipped,
        failed
      });
    }
  }

  return {
    scanned,
    queued,
    refreshed,
    skipped,
    failed
  };
}