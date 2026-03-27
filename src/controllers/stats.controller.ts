import { Request, Response } from "express";
import {
  getSummaryService,
  getByCategory,
  getTopItems,
  getCollectionValueHistory
} from "../services/stats.service";

export async function statsSummary(req: Request, res: Response) {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const summary = await getSummaryService(userId);
  res.json(summary);
}

export async function statsByCategory(req: Request, res: Response) {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const rows = await getByCategory(userId);
  res.json(rows);
}

export async function statsTopItems(req: Request, res: Response) {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const limit =
    typeof req.query.limit === "string" ? Number(req.query.limit) : 10;

  const category =
    typeof req.query.category === "string" ? req.query.category : undefined;

  const rows = await getTopItems(userId, limit, category);

  res.json(rows);
}

export async function statsCollectionHistory(req: Request, res: Response) {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const category =
    typeof req.query.category === "string" ? req.query.category : undefined;

  const history = await getCollectionValueHistory(userId, category);
  res.json(history);
}