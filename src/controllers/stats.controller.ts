import { Request, Response } from "express";
import {
  getSummaryService,
  getByCategoryService,
  getTopItemsService,
  getCollectionHistoryService,
  getTrendingItemsService,
  getMarketOverviewService
} from "../services/stats.service";

type HistoryRange = "7d" | "30d" | "90d" | "all";

function parseHistoryRange(value: unknown): HistoryRange {
  if (value === "7d" || value === "30d" || value === "90d") {
    return value;
  }

  return "all";
}

export async function getSummary(req: Request, res: Response) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const category =
      typeof req.query.category === "string" ? req.query.category : undefined;

    const minPrice =
      typeof req.query.minPrice === "string"
        ? Number(req.query.minPrice)
        : undefined;

    const maxPrice =
      typeof req.query.maxPrice === "string"
        ? Number(req.query.maxPrice)
        : undefined;

    const data = await getSummaryService({
      userId,
      q,
      category,
      minPrice,
      maxPrice
    });

    return res.json(data);
  } catch {
    return res.status(500).json({ message: "Failed to fetch summary" });
  }
}

export async function getByCategory(req: Request, res: Response) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const data = await getByCategoryService(userId);
    return res.json(data);
  } catch {
    return res.status(500).json({ message: "Failed to fetch categories" });
  }
}

export async function getTopItems(req: Request, res: Response) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const limit =
      typeof req.query.limit === "string" ? Number(req.query.limit) : 10;

    const category =
      typeof req.query.category === "string" ? req.query.category : undefined;

    const data = await getTopItemsService(userId, limit, category);
    return res.json(data);
  } catch {
    return res.status(500).json({ message: "Failed to fetch top items" });
  }
}

export async function getCollectionHistory(req: Request, res: Response) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const category =
      typeof req.query.category === "string" ? req.query.category : undefined;

    const range = parseHistoryRange(req.query.range);

    const data = await getCollectionHistoryService(userId, category, range);
    return res.json(data);
  } catch {
    return res.status(500).json({ message: "Failed to fetch collection history" });
  }
}

export async function getTrendingItems(req: Request, res: Response) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const direction =
      req.query.direction === "dropping" ? "dropping" : "rising";

    const limit =
      typeof req.query.limit === "string" ? Number(req.query.limit) : 5;

    const category =
      typeof req.query.category === "string" ? req.query.category : undefined;

    const data = await getTrendingItemsService(
      userId,
      direction,
      limit,
      category
    );

    return res.json(data);
  } catch {
    return res.status(500).json({ message: "Failed to fetch trending items" });
  }
}

export async function getMarketOverview(req: Request, res: Response) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const category =
      typeof req.query.category === "string" ? req.query.category : undefined;

    const data = await getMarketOverviewService(userId, category);
    return res.json(data);
  } catch {
    return res.status(500).json({ message: "Failed to fetch market overview" });
  }
}