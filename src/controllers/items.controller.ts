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

  res.json(result);
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

    res.status(201).json(item);
  } catch (error) {
    if (error instanceof FreePlanLimitError) {
      return res.status(403).json({
        message: "Free plan item limit reached",
        code: "FREE_ITEM_LIMIT_REACHED",
        limit: 50
      });
    }

    console.error(error);
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

  const item = await updateItemService({
    userId,
    id,
    quantity:
      typeof quantity === "number"
        ? quantity
        : quantity !== undefined
          ? Number(quantity)
          : undefined,
    estimatedPrice:
      typeof estimatedPrice === "number"
        ? estimatedPrice
        : estimatedPrice !== undefined
          ? Number(estimatedPrice)
          : undefined,
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

  res.json(item);
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

  res.status(204).send();
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

    const valuation = await getValuation(item);

    if (!valuation) {
      return res.status(400).json({ message: "No valuation found" });
    }

    const updated = await prisma.item.update({
      where: { id },
      data: {
        marketValue: valuation.price,
        valuationSource: valuation.source,
        valuationConfidence: valuation.confidence,
        lastValuationAt: new Date()
      }
    });

    await prisma.itemValuationSnapshot.create({
      data: {
        itemId: id,
        source: valuation.source,
        marketValue: valuation.price,
        confidence: valuation.confidence
      }
    });

    return res.json(updated);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Error valuating item" });
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
    let updated = 0;
    let skipped = 0;

    for (const item of items) {
      processed++;

      const valuation = await getValuation(item);

      if (!valuation) {
        skipped++;
        continue;
      }

      await prisma.item.update({
        where: { id: item.id },
        data: {
          marketValue: valuation.price,
          valuationSource: valuation.source,
          valuationConfidence: valuation.confidence,
          lastValuationAt: new Date()
        }
      });

      await prisma.itemValuationSnapshot.create({
        data: {
          itemId: item.id,
          source: valuation.source,
          marketValue: valuation.price,
          confidence: valuation.confidence
        }
      });

      updated++;
    }

    return res.json({
      processed,
      updated,
      skipped
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Error valuating collection" });
  }
};