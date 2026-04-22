import { Item } from "@prisma/client";
import prisma from "../prisma/client";
import { getCexPrice } from "./sources/cex.source";
import { getGamePrice } from "./sources/game.source";
import {
  ScraperAttemptLog,
  ScraperSourceResult
} from "./scraper.types";

type ValuationResult = {
  price: number;
  source: string;
  confidence: number;
};

type SourceDefinition = {
  name: string;
  handler: (item: Item) => Promise<ScraperSourceResult | null>;
};

const sources: SourceDefinition[] = [
  { name: "cex", handler: getCexPrice },
  { name: "game", handler: getGamePrice }
];

// ⏱️ 24h cache
const CACHE_TTL_HOURS = 24;

function buildCacheKey(item: Item) {
  return `${item.name}_${item.platform ?? ""}_${item.region ?? ""}`.toLowerCase();
}

function buildSourceQuery(item: Item) {
  return [item.name, item.platform ?? "", item.region ?? ""]
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join(" ");
}

function getCacheAgeHours(date: Date) {
  const now = new Date();
  return (now.getTime() - date.getTime()) / (1000 * 60 * 60);
}

function isCacheValid(date: Date) {
  return getCacheAgeHours(date) < CACHE_TTL_HOURS;
}

async function logScraperAttempts(
  item: Item,
  attempts: ScraperAttemptLog[]
) {
  if (attempts.length === 0) return;

  await prisma.scraperRunLog.createMany({
    data: attempts.map((attempt) => ({
      itemId: item.id,
      source: attempt.source,
      query: attempt.query ?? null,
      status: attempt.status,
      matchedTitle: attempt.matchedTitle ?? null,
      matchedUrl: attempt.matchedUrl ?? null,
      matchedPrice: attempt.matchedPrice ?? null,
      confidence: attempt.confidence ?? null,
      errorMessage: attempt.errorMessage ?? null
    }))
  });
}

async function scrapeValuation(item: Item): Promise<{
  valuation: ValuationResult | null;
  attempts: ScraperAttemptLog[];
}> {
  const defaultQuery = buildSourceQuery(item);

  const settled = await Promise.allSettled(
    sources.map(async (source) => {
      const result = await source.handler(item);
      return {
        source: source.name,
        result
      };
    })
  );

  const attempts: ScraperAttemptLog[] = [];
  const valid: ScraperSourceResult[] = [];

  for (let i = 0; i < settled.length; i++) {
    const entry = settled[i];
    const sourceName = sources[i]?.name ?? "unknown";

    if (entry.status === "fulfilled") {
      const result = entry.value.result;

      if (!result || result.price <= 0 || result.confidence <= 0) {
        attempts.push({
          source: sourceName,
          query: result?.query ?? defaultQuery,
          status: "NO_DATA"
        });
        continue;
      }

      valid.push(result);

      attempts.push({
        source: sourceName,
        query: result.query ?? defaultQuery,
        status: "SUCCESS",
        matchedTitle: result.matchedTitle,
        matchedUrl: result.matchedUrl,
        matchedPrice: result.price,
        confidence: result.confidence
      });

      continue;
    }

    attempts.push({
      source: sourceName,
      query: defaultQuery,
      status: "ERROR",
      errorMessage:
        entry.reason instanceof Error
          ? entry.reason.message
          : String(entry.reason)
    });
  }

  if (valid.length === 0) {
    return {
      valuation: null,
      attempts
    };
  }

  const totalWeight = valid.reduce((acc, v) => acc + v.confidence, 0);

  if (totalWeight === 0) {
    return {
      valuation: null,
      attempts
    };
  }

  const weightedPrice =
    valid.reduce((acc, v) => acc + v.price * v.confidence, 0) / totalWeight;

  const mergedSources = [...new Set(valid.map((v) => v.source))].join("+");

  const avgConfidence =
    valid.reduce((acc, v) => acc + v.confidence, 0) / valid.length;

  return {
    valuation: {
      price: Number(weightedPrice.toFixed(2)),
      source: mergedSources,
      confidence: Number(Math.min(0.95, avgConfidence).toFixed(2))
    },
    attempts
  };
}

/**
 * 🔵 Lectura pura (NO scrapea)
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
 * 🟡 Escritura (único punto que scrapea)
 */
export async function refreshValuation(
  item: Item
): Promise<ValuationResult | null> {
  const key = buildCacheKey(item);

  const { valuation, attempts } = await scrapeValuation(item);

  await logScraperAttempts(item, attempts);

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
        recordedAt: now
      }
    })
  ]);

  return valuation;
}

/**
 * 🧠 Utilidad para jobs
 */
export async function needsValuationRefresh(item: Item): Promise<boolean> {
  const key = buildCacheKey(item);

  const cache = await prisma.priceCache.findUnique({
    where: { key }
  });

  if (!cache) return true;

  return !isCacheValid(cache.updatedAt);
}