import { Request, Response } from "express";
import { exportItemsToCsv } from "../services/export.service";

export async function exportItemsCsv(req: Request, res: Response) {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const csv = await exportItemsToCsv(userId);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="items-export.csv"'
  );

  return res.send(csv);
}