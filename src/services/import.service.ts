import prisma from "../prisma/client";
import { parse } from "csv-parse/sync";
import { FreePlanLimitError } from "./items.service";
import {
  getItemLimitByPlan,
  normalizePlan
} from "../lib/plans";

type CsvRow = {
  name?: string;
  category?: string;
  estimatedPrice?: string;
  quantity?: string;
  condition?: string;
  platform?: string;
  completeness?: string;
  region?: string;
  notes?: string;
};

const allowedCategories = new Set([
  "videogame",
  "book",
  "comic",
  "tcg",
  "figure",
  "boardgame",
  "lego",
  "movie",
  "other"
]);

function toNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "string") return null;

  const normalized = value.trim().replace(",", ".");
  const n = Number(normalized);

  return Number.isFinite(n) ? n : null;
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export async function importItemsFromCsv(params: {
  buffer: Buffer;
  userId: string;
  plan?: string;
}) {
  const { buffer, userId, plan = "free" } = params;

  const text = buffer.toString("utf-8");

  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  }) as CsvRow[];

  const effectivePlan = normalizePlan(plan);
  const itemLimit = getItemLimitByPlan(effectivePlan);

  let inserted = 0;
  let updated = 0;
  let failed = 0;
  let stoppedByPlanLimit = false;

  const errors: Array<{ row: number; message: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];

    try {
      const name = (r.name ?? "").trim();
      const category = (r.category ?? "").trim();

      const price = toNumber(r.estimatedPrice);
      const qty = toNumber(r.quantity);

      if (!name) throw new Error("Missing name");
      if (!allowedCategories.has(category)) {
        throw new Error(`Invalid category: ${category}`);
      }
      if (price === null || price < 0) {
        throw new Error("Invalid estimatedPrice");
      }
      if (qty === null || qty < 1 || !Number.isInteger(qty)) {
        throw new Error("Invalid quantity");
      }

      const existing = await prisma.item.findFirst({
        where: {
          userId,
          name,
          category
        },
        select: { id: true }
      });

      if (existing) {
        await prisma.item.update({
          where: { id: existing.id },
          data: {
            estimatedPrice: price,
            quantity: qty,
            condition: toOptionalString(r.condition) ?? null,
            platform: toOptionalString(r.platform) ?? null,
            completeness: toOptionalString(r.completeness) ?? null,
            region: toOptionalString(r.region) ?? null,
            notes: toOptionalString(r.notes) ?? null
          }
        });

        await prisma.itemValuationSnapshot.create({
          data: {
            itemId: existing.id,
            source: "import_update",
            marketValue: price,
            confidence: 0.3
          }
        });

        updated++;
      } else {
        if (itemLimit != null) {
          const count = await prisma.item.count({
            where: { userId }
          });

          if (count >= itemLimit) {
            throw new FreePlanLimitError(
              itemLimit,
              `Plan item limit reached (${itemLimit} items)`
            );
          }
        }

        const item = await prisma.item.create({
          data: {
            userId,
            name,
            category,
            estimatedPrice: price,
            quantity: qty,
            condition: toOptionalString(r.condition) ?? null,
            platform: toOptionalString(r.platform) ?? null,
            completeness: toOptionalString(r.completeness) ?? null,
            region: toOptionalString(r.region) ?? null,
            notes: toOptionalString(r.notes) ?? null
          }
        });

        await prisma.itemValuationSnapshot.create({
          data: {
            itemId: item.id,
            source: "import",
            marketValue: price,
            confidence: 0.3
          }
        });

        inserted++;
      }
    } catch (error) {
      if (error instanceof FreePlanLimitError) {
        stoppedByPlanLimit = true;
        failed++;
        errors.push({
          row: i + 2,
          message: `Plan item limit reached (${error.limit} items). Import stopped.`
        });
        break;
      }

      failed++;
      errors.push({
        row: i + 2,
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  }

  return {
    inserted,
    updated,
    failed,
    stoppedByPlanLimit,
    errors
  };
}