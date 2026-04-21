import prisma from "../prisma/client";
import {
  getItemLimitByPlan,
  normalizePlan
} from "../lib/plans";

export class FreePlanLimitError extends Error {
  code: string;
  limit: number;

  constructor(limit: number, message?: string) {
    super(message ?? `Plan item limit reached (${limit} items)`);
    this.name = "FreePlanLimitError";
    this.code = "ITEM_LIMIT_REACHED";
    this.limit = limit;
  }
}

type CreateItemInput = {
  userId: string;
  plan?: string;
  name: string;
  category: string;
  estimatedPrice: number;
  quantity: number;
  condition?: string;
  platform?: string;
  completeness?: string;
  region?: string;
  notes?: string;
};

type ListItemsInput = {
  userId: string;
  q?: string;
  category?: string;
  sort?: string;
  minPrice?: number;
  maxPrice?: number;
  page?: number;
  pageSize?: number;
};

type UpdateItemInput = {
  quantity?: number;
  estimatedPrice?: number;
  condition?: string;
  platform?: string;
  completeness?: string;
  region?: string;
  notes?: string;
};

function hasValuationIdentityChanged(
  current: {
    platform: string | null;
    region: string | null;
  },
  incoming: UpdateItemInput
) {
  const nextPlatform =
    incoming.platform !== undefined ? incoming.platform || null : current.platform;

  const nextRegion =
    incoming.region !== undefined ? incoming.region || null : current.region;

  return nextPlatform !== current.platform || nextRegion !== current.region;
}

export async function createItemService(input: CreateItemInput) {
  const user = await prisma.user.findUnique({
    where: { id: input.userId }
  });

  if (!user) {
    throw new Error("User not found");
  }

  const effectivePlan = normalizePlan(input.plan ?? user.plan ?? "free");
  const itemLimit = getItemLimitByPlan(effectivePlan);

  if (itemLimit != null) {
    const count = await prisma.item.count({
      where: { userId: input.userId }
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
      userId: input.userId,
      name: input.name,
      category: input.category,
      estimatedPrice: input.estimatedPrice,
      quantity: input.quantity,
      condition: input.condition || null,
      platform: input.platform || null,
      completeness: input.completeness || null,
      region: input.region || null,
      notes: input.notes || null,
      marketValue: null,
      valuationSource: null,
      valuationConfidence: null,
      lastValuationAt: null
    }
  });

  if (input.estimatedPrice > 0) {
    await prisma.itemValuationSnapshot.create({
      data: {
        itemId: item.id,
        source: "manual",
        marketValue: input.estimatedPrice,
        confidence: 0.3
      }
    });
  }

  return item;
}

export async function listItemsService(input: ListItemsInput) {
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.max(1, input.pageSize ?? 25);
  const skip = (page - 1) * pageSize;

  const where: Record<string, unknown> = {
    userId: input.userId
  };

  if (input.q) {
    where.name = {
      contains: input.q,
      mode: "insensitive"
    };
  }

  if (input.category) {
    where.category = input.category;
  }

  if (input.minPrice != null || input.maxPrice != null) {
    where.estimatedPrice = {
      ...(input.minPrice != null ? { gte: input.minPrice } : {}),
      ...(input.maxPrice != null ? { lte: input.maxPrice } : {})
    };
  }

  let orderBy: Record<string, "asc" | "desc"> = { createdAt: "desc" };

  switch (input.sort) {
    case "price_asc":
      orderBy = { estimatedPrice: "asc" };
      break;
    case "price_desc":
      orderBy = { estimatedPrice: "desc" };
      break;
    case "name_asc":
      orderBy = { name: "asc" };
      break;
    case "name_desc":
      orderBy = { name: "desc" };
      break;
    case "created_asc":
      orderBy = { createdAt: "asc" };
      break;
    case "created_desc":
    default:
      orderBy = { createdAt: "desc" };
      break;
  }

  const [items, total] = await Promise.all([
    prisma.item.findMany({
      where,
      orderBy,
      skip,
      take: pageSize
    }),
    prisma.item.count({ where })
  ]);

  return {
    items,
    total,
    page,
    pageSize
  };
}

export async function getItemByIdService(userId: string, id: string) {
  return prisma.item.findFirst({
    where: {
      id,
      userId
    }
  });
}

export async function getItemSnapshotsService(userId: string, id: string) {
  const item = await prisma.item.findFirst({
    where: {
      id,
      userId
    }
  });

  if (!item) {
    return null;
  }

  return prisma.itemValuationSnapshot.findMany({
    where: { itemId: id },
    orderBy: { recordedAt: "desc" }
  });
}

export async function updateItemService(
  userId: string,
  id: string,
  data: UpdateItemInput
) {
  const item = await prisma.item.findFirst({
    where: {
      id,
      userId
    }
  });

  if (!item) {
    return null;
  }

  const shouldInvalidateStoredValuation = hasValuationIdentityChanged(item, data);

  const updated = await prisma.item.update({
    where: { id },
    data: {
      ...(data.quantity != null ? { quantity: data.quantity } : {}),
      ...(data.estimatedPrice != null
        ? { estimatedPrice: data.estimatedPrice }
        : {}),
      ...(data.condition !== undefined
        ? { condition: data.condition || null }
        : {}),
      ...(data.platform !== undefined
        ? { platform: data.platform || null }
        : {}),
      ...(data.completeness !== undefined
        ? { completeness: data.completeness || null }
        : {}),
      ...(data.region !== undefined ? { region: data.region || null } : {}),
      ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
      ...(shouldInvalidateStoredValuation
        ? {
            marketValue: null,
            valuationSource: null,
            valuationConfidence: null,
            lastValuationAt: null
          }
        : {})
    }
  });

  if (
    data.estimatedPrice != null &&
    data.estimatedPrice > 0 &&
    data.estimatedPrice !== Number(item.estimatedPrice)
  ) {
    await prisma.itemValuationSnapshot.create({
      data: {
        itemId: id,
        source: "manual_update",
        marketValue: data.estimatedPrice,
        confidence: 0.3
      }
    });
  }

  return updated;
}

export async function deleteItemService(userId: string, id: string) {
  const item = await prisma.item.findFirst({
    where: {
      id,
      userId
    }
  });

  if (!item) {
    return false;
  }

  await prisma.item.delete({
    where: { id }
  });

  return true;
}