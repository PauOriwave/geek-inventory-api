import { Request, Response } from "express";
import { importItemsFromCsv } from "../services/import.service";

export async function importItems(req: Request, res: Response) {
  const userId = req.user?.id;
  const plan = req.user?.plan ?? "free";

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  if (!req.file) {
    return res.status(400).json({ message: "CSV file is required" });
  }

  try {
    const result = await importItemsFromCsv({
      buffer: req.file.buffer,
      userId,
      plan
    });

    return res.json(result);
  } catch (error) {
    console.error("importItems route error:", error);

    return res.status(500).json({
      message:
        error instanceof Error
          ? error.message
          : "Error importing items"
    });
  }
}