import { parse } from "csv-parse/sync";
import prisma from "../prisma/client";
import { createItemSchema } from "../validators/item.schema";

export const importItemsFromCsvService = async (csvText: string) => {
  const records: any[] = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  const toInsert: any[] = [];
  const errors: any[] = [];

  records.forEach((r, idx) => {
    const rowNumber = idx + 2;

    const normalized = {
      name: (r.name ?? "").toString().trim(),
      category: (r.category ?? "").toString().trim(),
      estimatedPrice: r.estimatedPrice === undefined || r.estimatedPrice === "" ? NaN : Number(r.estimatedPrice),
      quantity: r.quantity === undefined || r.quantity === "" ? 1 : Number(r.quantity)
    };

    const parsedRow = createItemSchema.safeParse(normalized);

    if (!parsedRow.success) {
      errors.push({
        row: rowNumber,
        reason: parsedRow.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(" | "),
        data: r
      });
      return;
    }

    toInsert.push(parsedRow.data);
  });

  if (toInsert.length > 0) {
    await prisma.item.createMany({
      data: toInsert.map(it => ({
        name: it.name,
        category: it.category,
        estimatedPrice: it.estimatedPrice,
        quantity: it.quantity
      }))
    });
  }

  return {
    inserted: toInsert.length,
    failed: errors.length,
    errors
  };
};
