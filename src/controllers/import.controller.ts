import { Request, Response } from "express";
import { importItemsFromCsv } from "../services/import.service";

export async function importItems(req: Request, res: Response) {
  try {
    console.log("📦 importItems controller start");

    const userId = req.user?.id;
    const plan = req.user?.plan ?? "free";

    console.log("userId:", userId);
    console.log("plan:", plan);

    if (!userId) {
      console.log("❌ No userId");
      return res.status(401).json({ message: "Not authenticated" });
    }

    if (!req.file) {
      console.log("❌ No file");
      return res.status(400).json({ message: "CSV file is required" });
    }

    console.log("📄 file size:", req.file.size);

    const result = await importItemsFromCsv({
      buffer: req.file.buffer,
      userId,
      plan
    });

    console.log("✅ import result:", result);

    return res.json(result);
  } catch (error) {
    console.error("🔥 importItems ERROR:", error);

    return res.status(500).json({
      message:
        error instanceof Error
          ? error.message
          : "Error importing items"
    });
  }
}