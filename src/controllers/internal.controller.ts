import { Request, Response } from "express";
import prisma from "../prisma/client";
import { refreshValuation } from "../valuation/valuation.service";

function toPositiveInt(value: unknown, fallback: number) {
  const parsed =
    typeof value === "string" ? Number(value) :
    typeof value === "number" ? value :
    NaN;

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

/**
 * POST /internal/valuations/:id/refresh
 */
export const refreshItemValuation = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id).trim();

    console.log("[valuation] Refresh requested:", id);

    const item = await prisma.item.findUnique({
      where: { id }
    });

    if (!item) {
      console.warn("[valuation] Item not found:", id);

      return res.status(404).json({
        message: "Item not found",
        itemId: id
      });
    }

    const valuation = await refreshValuation(item);

    if (!valuation) {
      console.warn("[valuation] No data from sources:", id);

      return res.status(200).json({
        message: "No valuation sources returned data",
        itemId: id
      });
    }

    console.log("[valuation] Updated:", {
      itemId: id,
      price: valuation.price,
      source: valuation.source
    });

    return res.json({
      itemId: id,
      refreshed: true,
      valuation
    });
  } catch (err) {
    console.error("[valuation] refreshItemValuation error:", err);
    return res.status(500).json({ message: "Error refreshing valuation" });
  }
};

/**
 * POST /internal/valuations/refresh-all
 */
export const refreshAllValuations = async (req: Request, res: Response) => {
  try {
    const { userId } = req.query;

    const where = userId ? { userId: String(userId) } : {};

    const items = await prisma.item.findMany({
      where
    });

    let processed = 0;
    let updated = 0;
    let skipped = 0;

    for (const item of items) {
      processed++;

      const valuation = await refreshValuation(item);

      if (!valuation) {
        skipped++;
        continue;
      }

      updated++;
    }

    console.log("[valuation] batch result:", {
      processed,
      updated,
      skipped
    });

    return res.json({
      processed,
      updated,
      skipped
    });
  } catch (err) {
    console.error("[valuation] refreshAllValuations error:", err);
    return res.status(500).json({ message: "Error refreshing valuations" });
  }
};

/**
 * GET /internal/valuations/:id/logs
 */
export const getItemScraperLogs = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const take = Math.min(toPositiveInt(req.query.take, 50), 200);

    const item = await prisma.item.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        platform: true,
        region: true,
        lastValuationAt: true,
        marketValue: true,
        valuationSource: true,
        valuationConfidence: true
      }
    });

    if (!item) {
      return res.status(404).json({ message: "Item not found" });
    }

    const logs = await prisma.scraperRunLog.findMany({
      where: { itemId: id },
      orderBy: { createdAt: "desc" },
      take
    });

    return res.json({
      item,
      count: logs.length,
      logs
    });
  } catch (err) {
    console.error("[valuation] getItemScraperLogs error:", err);
    return res.status(500).json({ message: "Error fetching scraper logs" });
  }
};

/**
 * GET /internal/valuations/logs
 */
export const getScraperLogs = async (req: Request, res: Response) => {
  try {
    const source =
      typeof req.query.source === "string" ? req.query.source : undefined;

    const status =
      typeof req.query.status === "string" ? req.query.status : undefined;

    const itemId =
      typeof req.query.itemId === "string" ? req.query.itemId : undefined;

    const userId =
      typeof req.query.userId === "string" ? req.query.userId : undefined;

    const take = Math.min(toPositiveInt(req.query.take, 100), 500);

    const logs = await prisma.scraperRunLog.findMany({
      where: {
        ...(source ? { source } : {}),
        ...(status
          ? { status: status as "SUCCESS" | "NO_DATA" | "ERROR" }
          : {}),
        ...(itemId ? { itemId } : {}),
        ...(userId
          ? {
              item: {
                userId
              }
            }
          : {})
      },
      orderBy: { createdAt: "desc" },
      take,
      include: {
        item: {
          select: {
            id: true,
            name: true,
            platform: true,
            region: true,
            userId: true
          }
        }
      }
    });

    return res.json({
      count: logs.length,
      logs
    });
  } catch (err) {
    console.error("[valuation] getScraperLogs error:", err);
    return res.status(500).json({ message: "Error fetching scraper logs" });
  }
};