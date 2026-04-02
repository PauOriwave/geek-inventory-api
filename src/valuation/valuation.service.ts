import { Item } from "@prisma/client";
import { getCexPrice } from "./sources/cex.source";
import { getGamePrice } from "./sources/game.source";

type ValuationResult = {
  price: number;
  source: string;
  confidence: number;
};

const sources = [getCexPrice, getGamePrice];

export async function getValuation(
  item: Item
): Promise<ValuationResult | null> {
  const results = await Promise.allSettled(sources.map((source) => source(item)));

  const valid = results
    .filter(
      (result): result is PromiseFulfilledResult<ValuationResult | null> =>
        result.status === "fulfilled"
    )
    .map((result) => result.value)
    .filter((value): value is ValuationResult => Boolean(value && value.price > 0));

  if (valid.length === 0) {
    return null;
  }

  const totalWeight = valid.reduce((acc, v) => acc + v.confidence, 0);

  const weightedPrice =
    valid.reduce((acc, v) => acc + v.price * v.confidence, 0) / totalWeight;

  const mergedSources = [...new Set(valid.map((v) => v.source))].join("+");
  const avgConfidence = totalWeight / valid.length;

  return {
    price: Number(weightedPrice.toFixed(2)),
    source: mergedSources,
    confidence: Number(Math.min(0.95, avgConfidence).toFixed(2))
  };
}