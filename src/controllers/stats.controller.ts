import { Request, Response } from "express";
import { getSummaryService } from "../services/stats.service";

export const getSummary = async (_req: Request, res: Response) => {
  const summary = await getSummaryService();
  return res.json(summary);
};