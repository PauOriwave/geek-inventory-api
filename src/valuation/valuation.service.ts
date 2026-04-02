import { Item } from "@prisma/client";
import { getCexPrice } from "./sources/cex.source";
import { getGamePrice } from "./sources/game.source";

type ValuationResult = {
  price: number;
  source: string;
  confidence: number;
};

// orden de prioridad
const sources = [
  getCexPrice,
  getGamePrice
];

export async function getValuation(item: Item): Promise<ValuationResult | null> {
  const results = await Promise.allSettled(
    sources.map((s) => s(item))
  );

  const valid = results
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r: any) => r.value);

  if (valid.length === 0) return null;

  // media ponderada por confidence
  const totalWeight = valid.reduce((acc, v) => acc + v.confidence, 0);

  const weightedPrice =
    valid.reduce((acc, v) => acc + v.price * v.confidence, 0) / totalWeight;

  return {
    price: Number(weightedPrice.toFixed(2)),
    source: valid.map((v) => v.source).join("+"),
    confidence: Math.min(1, totalWeight / valid.length)
  };
}