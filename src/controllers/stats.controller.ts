import { Request, Response } from "express";
import {
  getSummaryService,
  getByCategoryService,
  getTopItemsService,
  getCollectionHistoryService,
  getTrendingItemsService
} from "../services/stats.service";

export async function getSummary(req: Request, res: Response) {
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
}

export async function getByCategory(req: Request, res: Response) {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const data = await getByCategoryService(userId);
  return res.json(data);
}

export async function getTopItems(req: Request, res: Response) {
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
}

export async function getCollectionHistory(req: Request, res: Response) {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const category =
    typeof req.query.category === "string" ? req.query.category : undefined;

  const data = await getCollectionHistoryService(userId, category);
  return res.json(data);
}

export async function getTrendingItems(req: Request, res: Response) {
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
}