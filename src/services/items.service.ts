import prisma from "../prisma/client";
import { Prisma } from "@prisma/client";

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

export const getItemByIdService = async (id: string) => {
  return prisma.item.findUnique({
    where: { id }
  });
};

export const deleteItemService = async (id: string) => {
  const existing = await prisma.item.findUnique({ where: { id } });
  if (!existing) return null;

  await prisma.item.delete({ where: { id } });
  return existing;
};

export const updateItemService = async (id: string, data: Prisma.ItemUpdateInput) => {
  return prisma.item.update({
    where: { id },
    data
  });
};