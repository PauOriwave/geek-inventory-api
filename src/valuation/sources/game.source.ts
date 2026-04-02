import { Item } from "@prisma/client";

export async function getGamePrice(item: Item) {
  if (!item.name) return null;

  const base = Number(item.estimatedPrice);

  return {
    price: base * 0.9, // GAME suele pagar menos
    source: "game",
    confidence: 0.6
  };
}