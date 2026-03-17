import { Request, Response } from "express";
import {
  listItemsService,
  createItemService,
  getItemByIdService,
  updateItemService,
  deleteItemService
} from "../services/items.service";

export const listItems = async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: "Not authenticated" });

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
  if (!userId) return res.status(401).json({ message: "Not authenticated" });

  const { name, category, estimatedPrice, quantity } = req.body;

  const item = await createItemService({
    userId,
    name,
    category,
    estimatedPrice: Number(estimatedPrice),
    quantity: Number(quantity)
  });

  res.status(201).json(item);
};

export const getItemById = async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: "Not authenticated" });

  const id = String(req.params.id);

  const item = await getItemByIdService(userId, id);

  if (!item) {
    return res.status(404).json({ message: "Item not found" });
  }

  return res.json(item);
};

export const updateItem = async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: "Not authenticated" });

  const id = String(req.params.id);
  const { quantity, estimatedPrice } = req.body;

  const item = await updateItemService({
    userId,
    id,
    quantity:
      typeof quantity === "number" ? quantity : quantity !== undefined ? Number(quantity) : undefined,
    estimatedPrice:
      typeof estimatedPrice === "number"
        ? estimatedPrice
        : estimatedPrice !== undefined
          ? Number(estimatedPrice)
          : undefined
  });

  if (!item) {
    return res.status(404).json({ message: "Item not found" });
  }

  res.json(item);
};

export const deleteItem = async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: "Not authenticated" });

  const id = String(req.params.id);

  const deleted = await deleteItemService(userId, id);

  if (!deleted) {
    return res.status(404).json({ message: "Item not found" });
  }

  res.status(204).send();
};