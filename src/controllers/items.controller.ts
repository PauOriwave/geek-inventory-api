import { Prisma } from "@prisma/client";
import { Request, Response } from "express";
import prisma from "../prisma/client";
import {
  listItemsService,
  createItemService,
  getItemByIdService,
  updateItemService,
  deleteItemService,
  FreePlanLimitError
} from "../services/items.service";
import { getValuation } from "../valuation/valuation.service";

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isNaN(value) ? undefined : value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
}

function getStoredValuationFromItem(item: {
  marketValue: Prisma.Decimal | null;
  valuationSource: string | null;
  valuationConfidence: number | null;
  lastValuationAt: Date | null;
}) {
  if (
    item.marketValue == null ||
    item.valuationSource == null ||
    item.valuationConfidence == null
  ) {
    return null;
  }

  return {
    price: item.marketValue.toNumber(),
    source: item.valuationSource,
    confidence: Number(item.valuationConfidence),
    lastValuationAt: item.lastValuationAt
  };
}

export const listItems = async (req: Request, res: Response) => {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  const category =
    typeof req.query.category === "string" ? req.query.category : undefined;
  const sort = typeof req.query.sort === "string" ? req.query.sort : undefined;

  const minPrice =
    typeof req.query.minPrice === "string"
      ? Number(req.query.minPrice)
      : undefined;

  const maxPrice =
    typeof req.query.maxPrice === "string"
      ? Number(req.query.maxPrice)
      : undefined;

  const page =
    typeof req.query.page === "string" ? Number(req.query.page) : 1;

  const pageSize =
    typeof req.query.pageSize === "string" ? Number(req.query.pageSize) : 25;

  const result = await listItemsService({
    userId,
    q,
    category,
    sort,
    minPrice,
    maxPrice,
    page,
    pageSize
  });

  return res.json(result);
};

export const createItem = async (req: Request, res: Response) => {
  const userId = req.user?.id;
  const plan = req.user?.plan ?? "free";

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const {
    name,
    category,
    estimatedPrice,
    quantity,
    condition,
    notes,
    platform,
    completeness,
    region
  } = req.body;

  try {
    const item = await createItemService({
      userId,
      plan,
      name,
      category,
      estimatedPrice: Number(estimatedPrice),
      quantity: Number(quantity),
      condition,
      notes,
      platform,
      completeness,
      region
    });

    return res.status(201).json(item);
  } catch (error) {
    if (error instanceof FreePlanLimitError) {
      return res.status(403).json({
        message: "Free plan item limit reached",
        code: "FREE_ITEM_LIMIT_REACHED",
        limit: 25
      });
    }

    console.error("createItem error:", error);
    return res.status(500).json({ message: "Error creating item" });
  }
};

export const getItemById = async (req: Request, res: Response) => {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const id = String(req.params.id);

  const item = await getItemByIdService(userId, id);

  if (!item) {
    return res.status(404).json({ message: "Item not found" });
  }

  return res.json(item);
};

export const getItemSnapshots = async (req: Request, res: Response) => {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const id = String(req.params.id);

  const item = await prisma.item.findFirst({
    where: {
      id,
      userId
    },
    select: {
      id: true
    }
  });

  if (!item) {
    return res.status(404).json({ message: "Item not found" });
  }

  const snapshots = await prisma.itemValuationSnapshot.findMany({
    where: {
      itemId: id
    },
    orderBy: {
      recordedAt: "desc"
    }
  });

  return res.json(snapshots);
};

export const updateItem = async (req: Request, res: Response) => {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const id = String(req.params.id);
  const {
    quantity,
    estimatedPrice,
    condition,
    notes,
    platform,
    completeness,
    region
  } = req.body;

  const item = await updateItemService(userId, id, {
    quantity: toOptionalNumber(quantity),
    estimatedPrice: toOptionalNumber(estimatedPrice),
    condition:
      typeof condition === "string"
        ? condition
        : condition === null
          ? ""
          : undefined,
    notes:
      typeof notes === "string"
        ? notes
        : notes === null
          ? ""
          : undefined,
    platform:
      typeof platform === "string"
        ? platform
        : platform === null
          ? ""
          : undefined,
    completeness:
      typeof completeness === "string"
        ? completeness
        : completeness === null
          ? ""
          : undefined,
    region:
      typeof region === "string"
        ? region
        : region === null
          ? ""
          : undefined
  });

  if (!item) {
    return res.status(404).json({ message: "Item not found" });
  }

  return res.json(item);
};

export const deleteItem = async (req: Request, res: Response) => {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const id = String(req.params.id);

  const deleted = await deleteItemService(userId, id);

  if (!deleted) {
    return res.status(404).json({ message: "Item not found" });
  }

  return res.status(204).send();
};

export const valuateItem = async (req: Request, res: Response) => {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  try {
    const id = String(req.params.id);

    const item = await prisma.item.findFirst({
      where: {
        id,
        userId
      }
    });

    if (!item) {
      return res.status(404).json({ message: "Item not found" });
    }

    const cachedValuation = await getValuation(item, { allowStale: true });
    const persistedValuation = getStoredValuationFromItem(item);

    const valuation = cachedValuation ?? persistedValuation;

    if (!valuation) {
      return res.status(404).json({
        message: "No stored valuation found for this item",
        code: "NO_STORED_VALUATION"
      });
    }

    return res.json({
      itemId: item.id,
      valuation: {
        price: valuation.price,
        source: valuation.source,
        confidence: valuation.confidence
      },
      lastValuationAt:
        "lastValuationAt" in valuation ? valuation.lastValuationAt : item.lastValuationAt,
      stale: item.lastValuationAt == null
    });
  } catch (err) {
    console.error("valuateItem error:", err);
    return res.status(500).json({ message: "Error reading item valuation" });
  }
};

export const valuateAllItems = async (req: Request, res: Response) => {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  try {
    const items = await prisma.item.findMany({
      where: { userId }
    });

    let processed = 0;
    let found = 0;
    let missing = 0;

    const results = [];

    for (const item of items) {
      processed++;

      const cachedValuation = await getValuation(item, { allowStale: true });
      const persistedValuation = getStoredValuationFromItem(item);

      const valuation = cachedValuation ?? persistedValuation;

      if (!valuation) {
        missing++;
        results.push({
          itemId: item.id,
          name: item.name,
          valuation: null
        });
        continue;
      }

      found++;
      results.push({
        itemId: item.id,
        name: item.name,
        valuation: {
          price: valuation.price,
          source: valuation.source,
          confidence: valuation.confidence
        },
        lastValuationAt:
          "lastValuationAt" in valuation
            ? valuation.lastValuationAt
            : item.lastValuationAt
      });
    }

    return res.json({
      processed,
      found,
      missing,
      results
    });
  } catch (err) {
    console.error("valuateAllItems error:", err);
    return res.status(500).json({ message: "Error reading collection valuation" });
  }
};