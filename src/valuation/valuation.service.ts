type ValuationResult = {
  source: "manual" | "cex" | "game";
  price: number;
  confidence: number;
};

export async function getValuation(item: {
  name: string;
  estimatedPrice: unknown;
}): Promise<ValuationResult | null> {
  const base = Number(item.estimatedPrice);

  if (!Number.isFinite(base) || base <= 0) {
    return null;
  }

  return {
    source: "manual",
    price: Number((base * 1.1).toFixed(2)),
    confidence: 0.5
  };
}