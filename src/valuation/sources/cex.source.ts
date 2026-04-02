import { Item } from "@prisma/client";

// ⚠️ Simulación por ahora (luego scraper real)
export async function getCexPrice(item: Item) {
  // lógica fake basada en nombre
  if (!item.name) return null;

  // simulación simple
  const base = Number(item.estimatedPrice);

  return {
    price: base * 1.1, // CEX suele inflar
    source: "cex",
    confidence: 0.7
  };
}