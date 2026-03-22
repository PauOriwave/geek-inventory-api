import { Request, Response } from "express";
import prisma from "../prisma/client";
import { parse } from "csv-parse/sync";

export async function importItems(req: Request, res: Response) {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const file = req.file;

  if (!file) {
    return res.status(400).json({ message: "CSV file is required" });
  }

  try {
    const csvText = file.buffer.toString("utf-8");

    const records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    let inserted = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const row of records) {
      try {
        const name = String(row.name ?? "").trim();
        const category = String(row.category ?? "").trim();
        const estimatedPrice = Number(row.estimatedPrice);
        const quantity = Number(row.quantity);

        if (!name) {
          failed++;
          errors.push("Missing name");
          continue;
        }

        if (!category) {
          failed++;
          errors.push(`Missing category for item "${name}"`);
          continue;
        }

        if (Number.isNaN(estimatedPrice) || estimatedPrice < 0) {
          failed++;
          errors.push(`Invalid estimatedPrice for item "${name}"`);
          continue;
        }

        if (Number.isNaN(quantity) || quantity < 1) {
          failed++;
          errors.push(`Invalid quantity for item "${name}"`);
          continue;
        }

        await prisma.item.create({
          data: {
            name,
            category,
            estimatedPrice,
            quantity,
            userId
          }
        });

        inserted++;
      } catch (err) {
        failed++;
        errors.push(
          err instanceof Error ? err.message : "Unknown import error"
        );
      }
    }

    return res.json({
      inserted,
      failed,
      errors
    });
  } catch {
    return res.status(400).json({ message: "Invalid CSV file" });
  }
}