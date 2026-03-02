import prisma from "../prisma/client";
import { parse } from "csv-parse/sync";

type CsvRow = {
  name?: string;
  category?: string;
  estimatedPrice?: string;
  quantity?: string;
};

const allowedCategories = new Set(["videogame", "book", "comic", "tcg", "figure", "other"]);

function toNumber(value: unknown): number | null {
  if (typeof value !== "string") return null;
  // soporta "12,50" o "12.50"
  const normalized = value.trim().replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export async function importItemsFromCsv(buffer: Buffer) {
  const text = buffer.toString("utf-8");

  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as CsvRow[];

  let inserted = 0;
  let updated = 0;
  let failed = 0;
  const errors: Array<{ row: number; message: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];

    try {
      const name = (r.name ?? "").trim();
      const category = (r.category ?? "").trim();

      const price = toNumber(r.estimatedPrice);
      const qty = toNumber(r.quantity);

      if (!name) throw new Error("Missing name");
      if (!allowedCategories.has(category)) throw new Error(`Invalid category: ${category}`);
      if (price === null || price <= 0) throw new Error("Invalid estimatedPrice");
      if (qty === null || qty < 1 || !Number.isInteger(qty)) throw new Error("Invalid quantity");

      // MERGE por (name + category)
      const existing = await prisma.item.findFirst({
        where: { name, category },
        select: { id: true },
      });

      if (existing) {
        await prisma.item.update({
          where: { id: existing.id },
          data: {
            estimatedPrice: price,
            quantity: qty, // <-- REPLACE quantity
          },
        });
        updated++;
      } else {
        await prisma.item.create({
          data: {
            name,
            category: category as any,
            estimatedPrice: price,
            quantity: qty,
          },
        });
        inserted++;
      }
    } catch (e: any) {
      failed++;
      errors.push({ row: i + 2, message: e?.message ?? "Unknown error" }); // +2 por header + 1-index
    }
  }

  return { inserted, updated, failed, errors };
}