import { Request, Response } from "express";
import { importItemsFromCsvService } from "../services/import.service";

export const importItemsCsv = async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ message: "Missing CSV file. Use form-data field name: file" });
  }

  const csvText = req.file.buffer.toString("utf-8");
  const result = await importItemsFromCsvService(csvText);

  return res.status(200).json(result);
};
