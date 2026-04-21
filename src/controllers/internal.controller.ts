import { Request, Response } from "express";
import prisma from "../prisma/client";
import { refreshValuation } from "../valuation/valuation.service";

/**
 * POST /internal/valuations/:id/refresh
 * Refresca valoración de un item concreto
 */
export const refreshItemValuation = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);

    const item = await prisma.item.findUnique({
      where: { id }
    });

    if (!item) {
      return res.status(404).json({ message: "Item not found" });
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