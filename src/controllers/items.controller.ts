import { Request, Response } from "express";
import { createItemSchema } from "../validators/item.schema";
import { createItemService, listItemsService } from "../services/items.service";

export const createItem = async (req: Request, res: Response) => {
  const parsed = createItemSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      message: "Validation error",
      errors: parsed.error.flatten()
    });
  }

  const item = await createItemService(parsed.data);
  return res.status(201).json(item);
};

export const listItems = async (_req: Request, res: Response) => {
  const items = await listItemsService();
  return res.json(items);
};
