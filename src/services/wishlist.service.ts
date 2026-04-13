import prisma from "../prisma/client";
import {
  getWishlistLimitByPlan,
  normalizePlan
} from "../lib/plans";

export class FreeWishlistLimitError extends Error {
  code: string;
  limit: number;

  constructor(limit: number, message?: string) {
    super(message ?? `Plan wishlist limit reached (${limit} items)`);
    this.name = "FreeWishlistLimitError";
    this.code = "WISHLIST_LIMIT_REACHED";
    this.limit = limit;
  }
}

type CreateWishlistInput = {
  userId: string;
  plan?: string;
  name: string;
  category?: string;
  targetPrice?: number;
  currentMarketValue?: number;
  platform?: string;
  region?: string;
  notes?: string;
};

export async function listWishlistService({
  userId
}: {
  userId: string;
}) {
  return prisma.wishlistItem.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" }
  });
}

export async function createWishlistService(input: CreateWishlistInput) {
  const user = await prisma.user.findUnique({
    where: { id: input.userId }
  });

  if (!user) {
    throw new Error("User not found");
  }

  const effectivePlan = normalizePlan(input.plan ?? user.plan ?? "free");
  const wishlistLimit = getWishlistLimitByPlan(effectivePlan);

  if (wishlistLimit != null) {
    const count = await prisma.wishlistItem.count({
      where: { userId: input.userId }
    });

    if (count >= wishlistLimit) {
      throw new FreeWishlistLimitError(
        wishlistLimit,
        `Plan wishlist limit reached (${wishlistLimit} items)`
      );
    }
  }

  return prisma.wishlistItem.create({
    data: {
      userId: input.userId,
      name: input.name,
      category: input.category || "other",
      targetPrice: input.targetPrice ?? null,
      currentMarketValue: input.currentMarketValue ?? null,
      platform: input.platform || null,
      region: input.region || null,
      notes: input.notes || null
    }
  });
}

export async function deleteWishlistService(userId: string, id: string) {
  const item = await prisma.wishlistItem.findFirst({
    where: {
      id,
      userId
    }
  });

  if (!item) {
    return false;
  }

  await prisma.wishlistItem.delete({
    where: { id }
  });

  return true;
}