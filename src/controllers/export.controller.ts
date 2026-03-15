import { Request, Response } from "express";
import { exportItemsToCsv } from "../services/export.service";

export async function exportItemsCsv(_req: Request, res: Response) {
  const csv = await exportItemsToCsv();

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="items-export.csv"');

  return res.send(csv);
}