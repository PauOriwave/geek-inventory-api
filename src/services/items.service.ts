import prisma from "../prisma/client";

type Category = "videogame" | "book" | "comic" | "tcg" | "figure" | "other";

export type CreateItemInput = {
  name: string;
  category: Category;
  estimatedPrice: number;
  quantity: number;
};

export const createItemService = async (data: CreateItemInput) => {
  return prisma.item.create({
    data: {
      name: data.name,
      category: data.category,
      estimatedPrice: data.estimatedPrice,
      quantity: data.quantity
    }
  });
};

export const listItemsService = async () => {
  return prisma.item.findMany({
    orderBy: { createdAt: "desc" }
  });
};
