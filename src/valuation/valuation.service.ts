import { Item } from "@prisma/client";
import prisma from "../prisma/client";
import { getCexPrice } from "./sources/cex.source";
import { getGamePrice } from "./sources/game.source";

type ValuationResult = {
  price: number;
  source: string;
  confidence: number;
};

const sources = [getCexPrice, getGamePrice];

// ⏱️ 24h cache
const CACHE_TTL_HOURS = 24;

function buildCacheKey(item: Item) {
  return `${item.name}_${item.platform ?? ""}_${item.region ?? ""}`.toLowerCase();
}

function isCacheValid(date: Date) {
  const now = new Date();
  const diff = (now.getTime() - date.getTime()) / (1000 * 60 * 60);
  return diff < CACHE_TTL_HOURS;
}

async function scrapeValuation(item: Item): Promise<ValuationResult | null> {
  const results = await Promise.allSettled(
    sources.map((source) => source(item))
  );

  const valid = results
    .filter(
      (result): result is PromiseFulfilledResult<ValuationResult | null> =>
        result.status === "fulfilled"
    )
    .map((result) => result.value)
    .filter(
      (value): value is ValuationResult =>
        Boolean(value && value.price > 0 && value.confidence > 0)
    );

  if (valid.length === 0) return null;

  const totalWeight = valid.reduce((acc, v) => acc + v.confidence, 0);
  if (totalWeight === 0) return null;

  const weightedPrice =
    valid.reduce((acc, v) => acc + v.price * v.confidence, 0) / totalWeight;

  const mergedSources = [...new Set(valid.map((v) => v.source))].join("+");

  const avgConfidence =
    valid.reduce((acc, v) => acc + v.confidence, 0) / valid.length;

  return {
    price: Number(weightedPrice.toFixed(2)),
    source: mergedSources,
    confidence: Number(Math.min(0.95, avgConfidence).toFixed(2))
  };
}

export async function getValuation(
  item: Item
): Promise<ValuationResult | null> {
  const key = buildCacheKey(item);

  // 🔍 1. Buscar cache
  const cache = await prisma.priceCache.findUnique({
    where: { key }
  });

  if (cache && isCacheValid(cache.updatedAt)) {
    return {
      price: Number(cache.price),
      source: cache.source,
      confidence: cache.confidence
    };
  }

  // 🌐 2. Scrapear
  const valuation = await scrapeValuation(item);

  if (!valuation) return null;

  // 💾 3. Guardar cache
  await prisma.priceCache.upsert({
    where: { key },
    update: {
      price: valuation.price,
      source: valuation.source,
      confidence: valuation.confidence
    },
    create: {
      key,
      price: valuation.price,
      source: valuation.source,
      confidence: valuation.confidence
    }
  });

  return valuation;
}