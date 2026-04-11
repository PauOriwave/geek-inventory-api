import prisma from "../prisma/client";

type CreateWishlistInput = {
  userId: string;
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

  if ((user.plan || "free") === "free") {
    const count = await prisma.wishlistItem.count({
      where: { userId: input.userId }
    });

    if (count >= 10) {
      const error = new Error("Free wishlist limit reached (10 items)");
      (error as Error & { code?: string }).code =
        "FREE_WISHLIST_LIMIT_REACHED";
      throw error;
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