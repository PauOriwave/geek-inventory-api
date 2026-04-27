import { Request, Response } from "express";
import prisma from "../prisma/client";
import { refreshValuation } from "../valuation/valuation.service";

function cleanId(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/[\n\r\t]/g, "");
}

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
 * Refresca valoración de un item concreto
 *
 * DEBUG TEMPORAL:
 * - limpia el ID solicitado
 * - imprime algunos items visibles para el backend
 * - compara si el ID existe entre los visibles
 */
export const refreshItemValuation = async (req: Request, res: Response) => {
  try {
    const rawId = req.params.id;
    const id = cleanId(rawId);

    console.log("[internal.refreshItemValuation] RAW ITEM ID:", JSON.stringify(rawId));
    console.log("[internal.refreshItemValuation] CLEAN ITEM ID:", JSON.stringify(id));
    console.log("[internal.refreshItemValuation] CLEAN ITEM ID LENGTH:", id.length);

    const debugItems = await prisma.item.findMany({
      select: {
        id: true,
        name: true,
        category: true,
        userId: true
      },
      take: 10,
      orderBy: {
        createdAt: "desc"
      }
    });

    const exactVisibleMatch = debugItems.find((debugItem) => debugItem.id === id);

    console.log(
      "[internal.refreshItemValuation] ITEMS VISIBLE TO BACKEND:",
      debugItems
    );

    console.log(
      "[internal.refreshItemValuation] EXACT VISIBLE MATCH:",
      exactVisibleMatch ?? null
    );

    const item = await prisma.item.findUnique({
      where: { id }
    });

    if (!item) {
      return res.status(404).json({
        message: "Item not found",
        rawRequestedId: rawId,
        requestedId: id,
        requestedIdLength: id.length,
        exactVisibleMatch: exactVisibleMatch ?? null,
        backendVisibleItems: debugItems
      });
    }

    const valuation = await refreshValuation(item);

    if (!valuation) {
      return res.status(200).json({
        message: "No valuation sources returned data",
        itemId: id
      });
    }

    return res.json({
      itemId: id,
      refreshed: true,
      valuation
    });
  } catch (err) {
    console.error("refreshItemValuation error:", err);
    return res.status(500).json({ message: "Error refreshing valuation" });
  }
};

/**
 * POST /internal/valuations/refresh-all
 * Refresca todos los items (opcionalmente filtrado por userId)
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

    return res.json({
      processed,
      updated,
      skipped
    });
  } catch (err) {
    console.error("refreshAllValuations error:", err);
    return res.status(500).json({ message: "Error refreshing valuations" });
  }
};

/**
 * GET /internal/valuations/:id/logs
 * Devuelve logs de scraper para un item concreto
 */
export const getItemScraperLogs = async (req: Request, res: Response) => {
  try {
    const id = cleanId(req.params.id);
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
      return res.status(404).json({ message: "Item not found", requestedId: id });
    }

    const logs = await prisma.scraperRunLog.findMany({
      where: { itemId: id },
      orderBy: { createdAt: "desc" },
      take
    });

    return res.json({
      item: {
        id: item.id,
        name: item.name,
        platform: item.platform,
        region: item.region,
        lastValuationAt: item.lastValuationAt,
        marketValue: item.marketValue,
        valuationSource: item.valuationSource,
        valuationConfidence: item.valuationConfidence
      },
      count: logs.length,
      logs
    });
  } catch (err) {
    console.error("getItemScraperLogs error:", err);
    return res.status(500).json({ message: "Error fetching scraper logs" });
  }
};

/**
 * GET /internal/valuations/logs
 * Filtros opcionales:
 * - source=world_viceous|chollo_games|juegos_mesa_redonda
 * - status=SUCCESS|NO_DATA|ERROR
 * - itemId=...
 * - userId=...
 * - take=50
 */
export const getScraperLogs = async (req: Request, res: Response) => {
  try {
    const source =
      typeof req.query.source === "string" ? req.query.source : undefined;

    const status =
      typeof req.query.status === "string" ? req.query.status : undefined;

    const itemId =
      typeof req.query.itemId === "string" ? cleanId(req.query.itemId) : undefined;

    const userId =
      typeof req.query.userId === "string" ? req.query.userId : undefined;

    const take = Math.min(toPositiveInt(req.query.take, 100), 500);

    const logs = await prisma.scraperRunLog.findMany({
      where: {
        ...(source ? { source } : {}),
        ...(status
          ? {
              status: status as "SUCCESS" | "NO_DATA" | "ERROR"
            }
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
    console.error("getScraperLogs error:", err);
    return res.status(500).json({ message: "Error fetching scraper logs" });
  }
};