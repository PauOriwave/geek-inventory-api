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

function getCacheAgeHours(date: Date) {
  const now = new Date();
  return (now.getTime() - date.getTime()) / (1000 * 60 * 60);
}

function isCacheValid(date: Date) {
  return getCacheAgeHours(date) < CACHE_TTL_HOURS;
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

/**
 * Lectura pura.
 * Nunca scrapea.
 *
 * allowStale = true:
 * - devuelve cache aunque esté vieja
 *
 * allowStale = false:
 * - solo devuelve cache válida según TTL
 */
export async function getValuation(
  item: Item,
  options?: { allowStale?: boolean }
): Promise<ValuationResult | null> {
  const allowStale = options?.allowStale ?? true;
  const key = buildCacheKey(item);

  const cache = await prisma.priceCache.findUnique({
    where: { key }
  });

  if (!cache) return null;

  if (!allowStale && !isCacheValid(cache.updatedAt)) {
    return null;
  }

  return {
    price: Number(cache.price),
    source: cache.source,
    confidence: cache.confidence
  };
}

/**
 * Refresco/escritura.
 * Este es el único punto que scrapea fuentes externas.
 *
 * Actualiza:
 * - PriceCache
 * - Item.marketValue
 * - Item.valuationSource
 * - Item.valuationConfidence
 * - Item.lastValuationAt
 * - ItemValuationSnapshot
 */
export async function refreshValuation(
  item: Item
): Promise<ValuationResult | null> {
  const key = buildCacheKey(item);

  const valuation = await scrapeValuation(item);

  if (!valuation) {
    return null;
  }

  const now = new Date();

  await prisma.$transaction([
    prisma.priceCache.upsert({
      where: { key },
      update: {
        price: valuation.price,
        source: valuation.source,
        confidence: valuation.confidence,
        updatedAt: now
      },
      create: {
        key,
        price: valuation.price,
        source: valuation.source,
        confidence: valuation.confidence,
        updatedAt: now
      }
    }),

    prisma.item.update({
      where: { id: item.id },
      data: {
        marketValue: valuation.price,
        valuationSource: valuation.source,
        valuationConfidence: valuation.confidence,
        lastValuationAt: now
      }
    }),

    prisma.itemValuationSnapshot.create({
      data: {
        itemId: item.id,
        marketValue: valuation.price,
        source: valuation.source,
        confidence: valuation.confidence,
        createdAt: now
      }
    })
  ]);

  return valuation;
}

/**
 * Utilidad opcional para jobs:
 * indica si un item necesita refresh según su cache actual.
 */
export async function needsValuationRefresh(item: Item): Promise<boolean> {
  const key = buildCacheKey(item);

  const cache = await prisma.priceCache.findUnique({
    where: { key }
  });

  if (!cache) return true;

  return !isCacheValid(cache.updatedAt);
}