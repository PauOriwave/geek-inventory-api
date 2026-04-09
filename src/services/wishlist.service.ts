import prisma from "../prisma/client";

type ListWishlistParams = {
  userId: string;
};

type CreateWishlistParams = {
  userId: string;
  name: string;
  category: string;
  targetPrice?: number;
  currentMarketValue?: number;
  platform?: string;
  region?: string;
  notes?: string;
};

const wishlistModel = (prisma as any).wishlistItem;

export async function listWishlistService({
  userId
}: ListWishlistParams) {
  return wishlistModel.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" }
  });
}

export async function createWishlistService({
  userId,
  name,
  category,
  targetPrice,
  currentMarketValue,
  platform,
  region,
  notes
}: CreateWishlistParams) {
  return wishlistModel.create({
    data: {
      userId,
      name,
      category,
      ...(typeof targetPrice === "number" && !Number.isNaN(targetPrice)
        ? { targetPrice }
        : {}),
      ...(typeof currentMarketValue === "number" &&
      !Number.isNaN(currentMarketValue)
        ? { currentMarketValue }
        : {}),
      ...(platform ? { platform } : {}),
      ...(region ? { region } : {}),
      ...(notes ? { notes } : {})
    }
  });
}

export async function deleteWishlistService(userId: string, id: string) {
  const existing = await wishlistModel.findFirst({
    where: {
      id,
      userId
    }
  });

  if (!existing) {
    return null;
  }

  await wishlistModel.delete({
    where: { id }
  });

  return true;
}