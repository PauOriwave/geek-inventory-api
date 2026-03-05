import { Request, Response } from "express";
import prisma from "../prisma/client";
import { getByCategory, getTopItems } from "../services/stats.service";

// GET /stats/summary  (filtrable por q/category/minPrice/maxPrice)
export const statsSummary = async (req: Request, res: Response) => {
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  const category = typeof req.query.category === "string" ? req.query.category : undefined;

  const minPrice = typeof req.query.minPrice === "string" ? Number(req.query.minPrice) : undefined;
  const maxPrice = typeof req.query.maxPrice === "string" ? Number(req.query.maxPrice) : undefined;

  const where: any = {};

  if (q) where.name = { contains: q, mode: "insensitive" };
  if (category) where.category = category;

  if (!Number.isNaN(minPrice ?? NaN) || !Number.isNaN(maxPrice ?? NaN)) {
    where.estimatedPrice = {};
    if (typeof minPrice === "number" && !Number.isNaN(minPrice)) where.estimatedPrice.gte = minPrice;
    if (typeof maxPrice === "number" && !Number.isNaN(maxPrice)) where.estimatedPrice.lte = maxPrice;
  }

  const items = await prisma.item.findMany({ where });

  const totalItems = items.length;
  const totalUnits = items.reduce((acc, i) => acc + i.quantity, 0);
  const totalValue = items.reduce(
    (acc, i) => acc + Number(i.estimatedPrice) * i.quantity,
    0
  );

  res.json({ totalItems, totalUnits, totalValue });
};

// GET /stats/by-category
export const statsByCategory = async (_req: Request, res: Response) => {
  const data = await getByCategory();
  res.json(data);
};

// GET /stats/top-items?limit=10
export const statsTopItems = async (req: Request, res: Response) => {
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 10;
  const data = await getTopItems(Number.isFinite(limit) ? limit : 10);
  res.json(data);
};