import { Request, Response } from "express";
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