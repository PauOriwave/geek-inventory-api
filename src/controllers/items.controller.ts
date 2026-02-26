import { Request, Response } from "express";
import prisma from "../prisma/client";
import { itemSchema } from "../validators/item.schema";
import { updateItemSchema } from "../validators/itemUpdate.schema";

/**
 * GET /items
 */
export const listItems = async (_req: Request, res: Response) => {
  const items = await prisma.item.findMany({
    orderBy: { createdAt: "desc" }
  });

  return res.json(items);
};

/**
 * POST /items
 */
export const createItem = async (req: Request, res: Response) => {
  const parsed = itemSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      message: "Validation error",
      errors: parsed.error.flatten()
    });
  }

  const item = await prisma.item.create({
    data: parsed.data
  });

  return res.status(201).json(item);
};

/**
 * PATCH /items/:id
 */
export const updateItem = async (req: Request, res: Response) => {
  const { id } = req.params;

  const parsed = updateItemSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      message: "Validation error",
      errors: parsed.error.flatten()
    });
  }

  try {
    const updated = await prisma.item.update({
      where: { id },
      data: parsed.data
    });

    return res.json(updated);
  } catch {
    return res.status(404).json({ message: "Item not found" });
  }
};

/**
 * DELETE /items/:id
 */
export const deleteItem = async (req: Request, res: Response) => {
  const id = String(req.params.id);

  try {
    await prisma.item.delete({ where: { id } });
    return res.status(204).send();
  } catch {
    return res.status(404).json({ message: "Item not found" });
  }
};