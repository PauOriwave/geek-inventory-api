import { Item } from "@prisma/client";

export async function getGamePrice(item: Item) {
  if (!item.name) return null;

  const base = Number(item.estimatedPrice);

  return {
    price: Number((base * 0.9).toFixed(2)),
    source: "game",
    confidence: 0.35
  };
}