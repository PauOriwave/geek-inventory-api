import { Request, Response } from "express";
import prisma from "../prisma/client";
import { itemSchema } from "../validators/item.schema";
import { updateItemSchema } from "../validators/itemUpdate.schema";

/**
 * GET /items
 */
export const listItems = async (req: Request, res: Response) => {
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  const category = typeof req.query.category === "string" ? req.query.category : undefined;

  const minPrice = typeof req.query.minPrice === "string" ? Number(req.query.minPrice) : undefined;
  const maxPrice = typeof req.query.maxPrice === "string" ? Number(req.query.maxPrice) : undefined;

  const sort = typeof req.query.sort === "string" ? req.query.sort : "newest";

  const page = typeof req.query.page === "string" ? Math.max(1, Number(req.query.page)) : 1;
  const pageSizeRaw = typeof req.query.pageSize === "string" ? Number(req.query.pageSize) : 25;
  const pageSize = Math.min(100, Math.max(5, Number.isFinite(pageSizeRaw) ? pageSizeRaw : 25));

  const where: any = {};

  if (q) where.name = { contains: q, mode: "insensitive" };
  if (category) where.category = category;

  if (!Number.isNaN(minPrice ?? NaN) || !Number.isNaN(maxPrice ?? NaN)) {
    where.estimatedPrice = {};
    if (typeof minPrice === "number" && !Number.isNaN(minPrice)) where.estimatedPrice.gte = minPrice;
    if (typeof maxPrice === "number" && !Number.isNaN(maxPrice)) where.estimatedPrice.lte = maxPrice;
  }

  const orderBy =
    sort === "price_asc" ? { estimatedPrice: "asc" } :
    sort === "price_desc" ? { estimatedPrice: "desc" } :
    { createdAt: "desc" };

  const [total, items] = await Promise.all([
    prisma.item.count({ where }),
    prisma.item.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize
    })
  ]);

  return res.json({ items, total, page, pageSize });
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