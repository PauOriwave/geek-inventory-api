import { Item } from "@prisma/client";
import prisma from "../prisma/client";
import { getWorldViceousPrice } from "./sources/world-viceous.source";
import { getCholloGamesPrice } from "./sources/chollo-games.source";
import { getJuegosMesaRedondaPrice } from "./sources/juegos-mesa-redonda.source";
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
  priority: number;
  handler: (item: Item) => Promise<ScraperSourceResult | null>;
};

const MIN_CONFIDENCE_FOR_VALUATION = 0.5;
const HIGH_CONFIDENCE_THRESHOLD = 0.88;

const sources: SourceDefinition[] = [
  {
    name: "world_viceous",
    priority: 90,
    handler: getWorldViceousPrice
  },
  {
    name: "chollo_games",
    priority: 80,
    handler: getCholloGamesPrice
  },
  {
    name: "juegos_mesa_redonda",
    priority: 85,
    handler: getJuegosMesaRedondaPrice
  }
];

const CACHE_TTL_HOURS = 24;

function buildCacheKey(item: Item) {
  return `${item.name}_${item.platform ?? ""}_${item.region ?? ""}`.toLowerCase();
}

function buildSourceQuery(item: Item) {
  return String(item.name || "").trim();
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
        source,
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

      attempts.push({
        source: sourceName,
        query: result.query ?? defaultQuery,
        status: "SUCCESS",
        matchedTitle: result.matchedTitle,
        matchedUrl: result.matchedUrl,
        matchedPrice: result.price,
        confidence: result.confidence
      });

      if (result.confidence < MIN_CONFIDENCE_FOR_VALUATION) {
        console.log("[valuation] Ignoring low confidence result:", {
          source: result.source,
          price: result.price,
          confidence: result.confidence,
          matchedTitle: result.matchedTitle
        });

        continue;
      }

      valid.push(result);
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

  const highConfidenceBest = pickHighConfidenceBest(valid);

  if (highConfidenceBest) {
    return {
      valuation: {
        price: Number(highConfidenceBest.price.toFixed(2)),
        source: highConfidenceBest.source,
        confidence: Number(Math.min(0.95, highConfidenceBest.confidence).toFixed(2))
      },
      attempts
    };
  }

  const weighted = calculateWeightedValuation(valid);

  return {
    valuation: weighted,
    attempts
  };
}

function pickHighConfidenceBest(
  results: ScraperSourceResult[]
): ScraperSourceResult | null {
  const highConfidence = results.filter(
    (result) => result.confidence >= HIGH_CONFIDENCE_THRESHOLD
  );

  if (highConfidence.length === 0) {
    return null;
  }

  highConfidence.sort((a, b) => {
    const aPriority = getSourcePriority(a.source);
    const bPriority = getSourcePriority(b.source);

    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }

    return bPriority - aPriority;
  });

  const best = highConfidence[0];

  if (!best) {
    return null;
  }

  console.log("[valuation] Using high confidence single source:", {
    source: best.source,
    price: best.price,
    confidence: best.confidence,
    matchedTitle: best.matchedTitle
  });

  return best;
}

function calculateWeightedValuation(
  results: ScraperSourceResult[]
): ValuationResult | null {
  const weightedResults = results.map((result) => {
    const priority = getSourcePriority(result.source);
    const weight = result.confidence * priority;

    return {
      result,
      weight
    };
  });

  const totalWeight = weightedResults.reduce(
    (acc, entry) => acc + entry.weight,
    0
  );

  if (totalWeight <= 0) {
    return null;
  }

  const weightedPrice =
    weightedResults.reduce(
      (acc, entry) => acc + entry.result.price * entry.weight,
      0
    ) / totalWeight;

  const mergedSources = [
    ...new Set(weightedResults.map((entry) => entry.result.source))
  ].join("+");

  const avgConfidence =
    weightedResults.reduce((acc, entry) => acc + entry.result.confidence, 0) /
    weightedResults.length;

  return {
    price: Number(weightedPrice.toFixed(2)),
    source: mergedSources,
    confidence: Number(Math.min(0.95, avgConfidence).toFixed(2))
  };
}

function getSourcePriority(sourceName: string): number {
  const source = sources.find((entry) => entry.name === sourceName);

  return source?.priority ?? 50;
}

/**
 * 🔵 Lectura pura.
 * NO scrapea nunca.
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
 * 🟡 Escritura/background.
 * Único punto que scrapea fuentes externas.
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
 * 🧠 Utilidad para jobs.
 */
export async function needsValuationRefresh(item: Item): Promise<boolean> {
  const key = buildCacheKey(item);

  const cache = await prisma.priceCache.findUnique({
    where: { key }
  });

  if (!cache) return true;

  return !isCacheValid(cache.updatedAt);
}