import { Request, Response } from "express";
import prisma from "../prisma/client";
import {
  listWishlistService,
  createWishlistService,
  deleteWishlistService
} from "../services/wishlist.service";

export async function listWishlist(req: Request, res: Response) {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const items = await listWishlistService({ userId });
  return res.json(items);
}

export async function createWishlistItem(req: Request, res: Response) {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const {
    name,
    category,
    targetPrice,
    currentMarketValue,
    platform,
    region,
    notes
  } = req.body;

  const item = await createWishlistService({
    userId,
    name,
    category,
    targetPrice:
      targetPrice !== undefined ? Number(targetPrice) : undefined,
    currentMarketValue:
      currentMarketValue !== undefined
        ? Number(currentMarketValue)
        : undefined,
    platform,
    region,
    notes
  });

  return res.status(201).json(item);
}

export async function deleteWishlistItem(req: Request, res: Response) {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const id = String(req.params.id);
  const deleted = await deleteWishlistService(userId, id);

  if (!deleted) {
    return res.status(404).json({ message: "Wishlist item not found" });
  }

  return res.status(204).send();
}

export async function moveWishlistItemToCollection(
  req: Request,
  res: Response
) {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const id = String(req.params.id);

  const wishlistItem = await (prisma as any).wishlistItem.findFirst({
    where: {
      id,
      userId
    }
  });

  if (!wishlistItem) {
    return res.status(404).json({ message: "Wishlist item not found" });
  }

  const createdItem = await prisma.item.create({
    data: {
      name: wishlistItem.name,
      category: wishlistItem.category || "other",
      estimatedPrice: wishlistItem.targetPrice || 0,
      quantity: 1,
      userId,
      platform: wishlistItem.platform || null,
      region: wishlistItem.region || null,
      notes: wishlistItem.notes || null
    }
  });

  await (prisma as any).wishlistItem.delete({
    where: { id }
  });

  return res.json(createdItem);
}