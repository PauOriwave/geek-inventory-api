import prisma from "../prisma/client";

type ListItemsParams = {
  userId: string;
  q?: string;
  category?: string;
  sort?: string;
  minPrice?: number;
  maxPrice?: number;
  page?: number;
  pageSize?: number;
};

type CreateItemParams = {
  userId: string;
  name: string;
  category: string;
  estimatedPrice: number;
  quantity: number;
  condition?: string;
  notes?: string;
  platform?: string;
  completeness?: string;
};

type UpdateItemParams = {
  userId: string;
  id: string;
  quantity?: number;
  estimatedPrice?: number;
  condition?: string;
  notes?: string;
  platform?: string;
  completeness?: string;
};

export const listItemsService = async ({
  userId,
  q,
  category,
  sort,
  minPrice,
  maxPrice,
  page = 1,
  pageSize = 25
}: ListItemsParams) => {
  const where: any = {
    userId
  };

  if (q) {
    where.name = {
      contains: q,
      mode: "insensitive"
    };
  }

  if (category) {
    where.category = category;
  }

  if (
    (typeof minPrice === "number" && !Number.isNaN(minPrice)) ||
    (typeof maxPrice === "number" && !Number.isNaN(maxPrice))
  ) {
    where.estimatedPrice = {};

    if (typeof minPrice === "number" && !Number.isNaN(minPrice)) {
      where.estimatedPrice.gte = minPrice;
    }

    if (typeof maxPrice === "number" && !Number.isNaN(maxPrice)) {
      where.estimatedPrice.lte = maxPrice;
    }
  }

  let orderBy: any = { createdAt: "desc" };

  if (sort === "price_desc") {
    orderBy = { estimatedPrice: "desc" };
  }

  if (sort === "price_asc") {
    orderBy = { estimatedPrice: "asc" };
  }

  const total = await prisma.item.count({ where });

  const items = await prisma.item.findMany({
    where,
    orderBy,
    skip: (page - 1) * pageSize,
    take: pageSize
  });

  return {
    items,
    total,
    page,
    pageSize
  };
};

export const createItemService = async ({
  userId,
  name,
  category,
  estimatedPrice,
  quantity,
  condition,
  notes,
  platform,
  completeness
}: CreateItemParams) => {
  return prisma.item.create({
    data: {
      name,
      category,
      estimatedPrice,
      quantity,
      userId,
      condition,
      notes,
      platform,
      completeness
    }
  });
};

export const getItemByIdService = async (userId: string, id: string) => {
  return prisma.item.findFirst({
    where: {
      id,
      userId
    }
  });
};

export const updateItemService = async ({
  userId,
  id,
  quantity,
  estimatedPrice,
  condition,
  notes,
  platform,
  completeness
}: UpdateItemParams) => {
  const existing = await prisma.item.findFirst({
    where: {
      id,
      userId
    }
  });

  if (!existing) return null;

  return prisma.item.update({
    where: { id },
    data: {
      ...(typeof quantity === "number" ? { quantity } : {}),
      ...(typeof estimatedPrice === "number" ? { estimatedPrice } : {}),
      ...(condition !== undefined ? { condition } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(platform !== undefined ? { platform } : {}),
      ...(completeness !== undefined ? { completeness } : {})
    }
  });
};

export const deleteItemService = async (userId: string, id: string) => {
  const existing = await prisma.item.findFirst({
    where: {
      id,
      userId
    }
  });

  if (!existing) return null;

  await prisma.item.delete({
    where: { id }
  });

  return true;
};