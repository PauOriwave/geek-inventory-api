import { Item, Prisma } from "@prisma/client";
import prisma from "../prisma/client";

import { getPriceChartingVideogamePrice } from "./sources/pricecharting-videogame.source";
import { getPriceChartingComicPrice } from "./sources/pricecharting-comic.source";
import { getWorldViceousPrice } from "./sources/world-viceous.source";
import { getCholloGamesPrice } from "./sources/chollo-games.source";
import { getJuegosMesaRedondaPrice } from "./sources/juegos-mesa-redonda.source";
import { getDungeonMarvelsPrice } from "./sources/dungeon-marvels.source";
import { getBrickEconomyPrice } from "./sources/brickeconomy.source";
import { getDvdStoreSpainPrice } from "./sources/dvd-store-spain.source";
import { getGoblinTraderPrice } from "./sources/goblin-trader.source";
import { getPokemonTcgPrice } from "./sources/pokemon-tcg.source";
import { getTcgDexPrice } from "./sources/tcgdex.source";
import { getCardTraderPrice } from "./sources/cardtrader.source";
import { getScryfallPrice } from "./sources/scryfall.source";
import { getNormaComicsPrice } from "./sources/norma-comics.source";
import { getLaCentralPrice } from "./sources/la-central.source";
import { getTodosTusLibrosPrice } from "./sources/todos-tus-libros.source";
import { getFunkoEuropePrice } from "./sources/funko-europe.source";
import { getPriceChartingFunkoPrice } from "./sources/pricecharting-funko.source";

import {
  ScraperAttemptLog,
  ScraperSourceResult,
  SupportedCurrency
} from "./scraper.types";

type ValuationResult = {
  price: number;
  source: string;
  confidence: number;
  currency?: SupportedCurrency | null;
};

type SourceDefinition = {
  name: string;
  priority: number;
  categories: string[];
  handler: (item: Item) => Promise<ScraperSourceResult | null>;
};

const MIN_CONFIDENCE_FOR_VALUATION = 0.5;
const HIGH_CONFIDENCE_THRESHOLD = 0.88;
const TCG_DUNGEON_MARVELS_MIN_CONFIDENCE = 0.8;

const sources: SourceDefinition[] = [
  {
    name: "pricecharting_videogame",
    priority: 91,
    categories: ["videogame"],
    handler: getPriceChartingVideogamePrice
  },
  {
    name: "world_viceous",
    priority: 90,
    categories: ["videogame"],
    handler: getWorldViceousPrice
  },
  {
    name: "chollo_games",
    priority: 80,
    categories: ["videogame"],
    handler: getCholloGamesPrice
  },
  {
    name: "todos_tus_libros",
    priority: 86,
    categories: ["book"],
    handler: getTodosTusLibrosPrice
  },
  {
    name: "la_central",
    priority: 76,
    categories: ["book"],
    handler: getLaCentralPrice
  },
  {
    name: "pricecharting_comic",
    priority: 89,
    categories: ["comic"],
    handler: getPriceChartingComicPrice
  },
  {
    name: "norma_comics",
    priority: 86,
    categories: ["comic", "book"],
    handler: getNormaComicsPrice
  },
  {
    name: "juegos_mesa_redonda",
    priority: 85,
    categories: ["boardgame"],
    handler: getJuegosMesaRedondaPrice
  },
  {
    name: "pricecharting_funko",
    priority: 94,
    categories: ["figure"],
    handler: getPriceChartingFunkoPrice
  },
  {
    name: "funko_europe",
    priority: 90,
    categories: ["figure"],
    handler: getFunkoEuropePrice
  },
  {
    name: "dungeon_marvels",
    priority: 86,
    categories: ["boardgame", "miniature", "comic", "tcg", "figure", "lego"],
    handler: getDungeonMarvelsPrice
  },
  {
    name: "goblin_trader",
    priority: 88,
    categories: ["boardgame", "miniature", "figure", "merch"],
    handler: getGoblinTraderPrice
  },
  {
    name: "brickeconomy",
    priority: 92,
    categories: ["lego"],
    handler: getBrickEconomyPrice
  },
  {
    name: "dvd_store_spain",
    priority: 86,
    categories: ["movie"],
    handler: getDvdStoreSpainPrice
  },
  {
    name: "pokemon_tcg_api",
    priority: 93,
    categories: ["tcg"],
    handler: getPokemonTcgPrice
  },
  {
    name: "tcgdex",
    priority: 95,
    categories: ["tcg"],
    handler: getTcgDexPrice
  },
  {
    name: "cardtrader",
    priority: 99,
    categories: ["tcg"],
    handler: getCardTraderPrice
  },
  {
    name: "scryfall",
    priority: 88,
    categories: ["tcg"],
    handler: getScryfallPrice
  }
];

const CACHE_TTL_HOURS = 24;

function getSourcesForItem(item: Item): SourceDefinition[] {
  const categorySources = sources.filter((source) =>
    source.categories.includes(item.category)
  );

  if (item.category === "figure") {
    const platform = normalizePlatform(item.platform);

    if (platform === "funko_pop" || isFunkoPopItem(item)) {
      return categorySources.filter((source) =>
        [
          "pricecharting_funko",
          "funko_europe",
          "dungeon_marvels",
          "goblin_trader"
        ].includes(source.name)
      );
    }

    return categorySources.filter((source) =>
      ["dungeon_marvels", "goblin_trader"].includes(source.name)
    );
  }

  if (item.category !== "tcg") return categorySources;

  const platform = normalizePlatform(item.platform);

  if (platform === "pokemon") {
    return categorySources.filter((source) =>
      ["pokemon_tcg_api", "tcgdex", "cardtrader", "dungeon_marvels"].includes(
        source.name
      )
    );
  }

  if (platform === "magic") {
    return categorySources.filter((source) =>
      ["cardtrader", "scryfall", "dungeon_marvels"].includes(source.name)
    );
  }

  if (
    platform === "yugioh" ||
    platform === "onepiece" ||
    platform === "lorcana" ||
    platform === "digimon" ||
    platform === "fleshandblood"
  ) {
    return categorySources.filter((source) =>
      ["cardtrader", "dungeon_marvels"].includes(source.name)
    );
  }

  return categorySources;
}

function normalizePlatform(value: string | null): string | null {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();

  if (!normalized) return null;

  if (
    normalized === "funko" ||
    normalized === "funkopop" ||
    normalized === "pop" ||
    normalized === "pops"
  ) {
    return "funko_pop";
  }

  if (
    normalized === "pokemon" ||
    normalized === "pokemontcg" ||
    normalized === "pokémon" ||
    normalized === "pokémontcg"
  ) {
    return "pokemon";
  }

  if (
    normalized === "yugioh" ||
    normalized === "yugiohtcg" ||
    normalized === "yugi" ||
    normalized === "yu-gi-oh"
  ) {
    return "yugioh";
  }

  if (
    normalized === "magic" ||
    normalized === "mtg" ||
    normalized === "magicthegathering"
  ) {
    return "magic";
  }

  if (
    normalized === "onepiece" ||
    normalized === "onepiecetcg" ||
    normalized === "optcg"
  ) {
    return "onepiece";
  }

  if (normalized === "lorcana" || normalized === "disneylorcana") {
    return "lorcana";
  }

  if (normalized === "digimon" || normalized === "digimontcg") {
    return "digimon";
  }

  if (normalized === "fleshandblood" || normalized === "fab") {
    return "fleshandblood";
  }

  return normalized;
}

function isFunkoPopItem(item: Item): boolean {
  const text = `${item.name} ${item.platform ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  return text.includes("funko pop") || text.includes("funko");
}

function buildCacheKey(item: Item) {
  return `${item.name}_${item.platform ?? ""}_${item.region ?? ""}`.toLowerCase();
}

function buildSourceQuery(item: Item) {
  return String(item.name || "").trim();
}

function getCacheAgeHours(date: Date) {
  return (new Date().getTime() - date.getTime()) / (1000 * 60 * 60);
}

function isCacheValid(date: Date) {
  return getCacheAgeHours(date) < CACHE_TTL_HOURS;
}

async function logScraperAttempts(item: Item, attempts: ScraperAttemptLog[]) {
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
      currency: attempt.currency ?? null,
      confidence: attempt.confidence ?? null,
      errorMessage: attempt.errorMessage ?? null
    }))
  });
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_, nestedValue) => {
      if (nestedValue === undefined) return null;
      return nestedValue;
    })
  ) as Prisma.InputJsonValue;
}

async function saveSourceMarketData(item: Item, results: ScraperSourceResult[]) {
  const enrichedResults = results.filter(
    (result) => result.metadata && Object.keys(result.metadata).length > 0
  );

  if (enrichedResults.length === 0) return;

  try {
    await prisma.sourceMarketData.createMany({
      data: enrichedResults.map((result) => ({
        itemId: item.id,
        source: result.source,
        sourceUrl: result.matchedUrl ?? null,
        rawData: toPrismaJson({
          price: result.price,
          currency: result.currency ?? null,
          confidence: result.confidence,
          matchedTitle: result.matchedTitle ?? null,
          matchedUrl: result.matchedUrl ?? null,
          query: result.query ?? null,
          metadata: result.metadata ?? {}
        })
      }))
    });
  } catch (error) {
    console.log("[valuation] sourceMarketData save skipped:", error);
  }
}

async function scrapeValuation(item: Item): Promise<{
  valuation: ValuationResult | null;
  attempts: ScraperAttemptLog[];
  validResults: ScraperSourceResult[];
  marketDataResults: ScraperSourceResult[];
}> {
  const defaultQuery = buildSourceQuery(item);
  const activeSources = getSourcesForItem(item);

  console.log("[valuation] item:", {
    id: item.id,
    name: item.name,
    category: item.category,
    platform: item.platform,
    normalizedPlatform: normalizePlatform(item.platform),
    region: item.region
  });

  console.log(
    "[valuation] sources enabled:",
    activeSources.map((source) => source.name)
  );

  if (activeSources.length === 0) {
    return {
      valuation: null,
      attempts: [],
      validResults: [],
      marketDataResults: []
    };
  }

  const settled = await Promise.allSettled(
    activeSources.map(async (source) => {
      console.log("[valuation] running source:", source.name);

      const result = await source.handler(item);

      console.log("[valuation] source finished:", {
        source: source.name,
        hasResult: Boolean(result),
        price: result?.price,
        currency: result?.currency,
        confidence: result?.confidence,
        matchedTitle: result?.matchedTitle
      });

      return { source, result };
    })
  );

  const attempts: ScraperAttemptLog[] = [];
  const valid: ScraperSourceResult[] = [];
  const marketDataResults: ScraperSourceResult[] = [];

  for (let i = 0; i < settled.length; i++) {
    const entry = settled[i];
    const sourceName = activeSources[i]?.name ?? "unknown";

    if (entry.status === "fulfilled") {
      const result = entry.value.result;

      if (result?.metadata && Object.keys(result.metadata).length > 0) {
        marketDataResults.push(result);
      }

      if (!result || result.price <= 0 || result.confidence <= 0) {
        attempts.push({
          source: sourceName,
          query: result?.query ?? defaultQuery,
          status: "NO_DATA",
          matchedTitle: result?.matchedTitle,
          matchedUrl: result?.matchedUrl,
          matchedPrice:
            result?.price && result.price > 0 ? result.price : undefined,
          currency: result?.currency ?? null,
          confidence: result?.confidence
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
        currency: result.currency ?? null,
        confidence: result.confidence
      });

      const requiredConfidence = getMinimumConfidenceForResult(item, result);

      if (result.confidence < requiredConfidence) {
        console.log("[valuation] Ignoring low confidence result:", {
          source: result.source,
          price: result.price,
          currency: result.currency,
          confidence: result.confidence,
          requiredConfidence,
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
      attempts,
      validResults: [],
      marketDataResults
    };
  }

  const preferred = pickPreferredValuationResult(item, valid);

  if (preferred) {
    return {
      valuation: {
        price: Number(preferred.price.toFixed(2)),
        currency: preferred.currency ?? null,
        source: preferred.source,
        confidence: Number(Math.min(0.95, preferred.confidence).toFixed(2))
      },
      attempts,
      validResults: valid,
      marketDataResults
    };
  }

  const weighted = calculateWeightedValuation(valid);

  return {
    valuation: weighted,
    attempts,
    validResults: valid,
    marketDataResults
  };
}

function getMinimumConfidenceForResult(
  item: Item,
  result: ScraperSourceResult
): number {
  if (item.category === "tcg" && result.source === "dungeon_marvels") {
    return TCG_DUNGEON_MARVELS_MIN_CONFIDENCE;
  }

  return MIN_CONFIDENCE_FOR_VALUATION;
}

function pickPreferredValuationResult(
  item: Item,
  results: ScraperSourceResult[]
): ScraperSourceResult | null {
  if (item.category === "tcg") {
    const cardTraderBestDeal = results.find((result) => {
      if (result.source !== "cardtrader") return false;

      const metadata = result.metadata ?? {};
      const priceBasis = String(metadata.priceBasis ?? "");

      return (
        result.confidence >= HIGH_CONFIDENCE_THRESHOLD ||
        priceBasis === "text.Best Deal" ||
        Boolean(metadata.bestDeal)
      );
    });

    if (cardTraderBestDeal) {
      console.log("[valuation] Using CardTrader TCG preferred result:", {
        source: cardTraderBestDeal.source,
        price: cardTraderBestDeal.price,
        currency: cardTraderBestDeal.currency,
        confidence: cardTraderBestDeal.confidence,
        matchedTitle: cardTraderBestDeal.matchedTitle
      });

      return cardTraderBestDeal;
    }
  }

  const highConfidence = results.filter(
    (result) => result.confidence >= HIGH_CONFIDENCE_THRESHOLD
  );

  if (highConfidence.length === 0) return null;

  highConfidence.sort((a, b) => {
    const aPriority = getSourcePriority(a.source);
    const bPriority = getSourcePriority(b.source);

    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }

    return bPriority - aPriority;
  });

  const best = highConfidence[0];

  if (!best) return null;

  console.log("[valuation] Using high confidence source:", {
    source: best.source,
    price: best.price,
    currency: best.currency,
    confidence: best.confidence,
    matchedTitle: best.matchedTitle
  });

  return best;
}

function calculateWeightedValuation(
  results: ScraperSourceResult[]
): ValuationResult | null {
  const compatibleResults = filterCurrencyCompatibleResults(results);

  const weightedResults = compatibleResults.map((result) => {
    const priority = getSourcePriority(result.source);
    const weight = result.confidence * priority;

    return { result, weight };
  });

  const totalWeight = weightedResults.reduce(
    (acc, entry) => acc + entry.weight,
    0
  );

  if (totalWeight <= 0) return null;

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

  const currency = weightedResults[0]?.result.currency ?? null;

  console.log("[valuation] Using weighted valuation:", {
    sources: mergedSources,
    price: Number(weightedPrice.toFixed(2)),
    currency,
    confidence: Number(Math.min(0.95, avgConfidence).toFixed(2))
  });

  return {
    price: Number(weightedPrice.toFixed(2)),
    currency,
    source: mergedSources,
    confidence: Number(Math.min(0.95, avgConfidence).toFixed(2))
  };
}

function filterCurrencyCompatibleResults(
  results: ScraperSourceResult[]
): ScraperSourceResult[] {
  const withCurrency = results.filter((result) => result.currency);
  const withoutCurrency = results.filter((result) => !result.currency);

  if (withCurrency.length === 0) return results;

  const currencyScores = new Map<SupportedCurrency, number>();

  for (const result of withCurrency) {
    const currency = result.currency as SupportedCurrency;
    const current = currencyScores.get(currency) ?? 0;

    currencyScores.set(
      currency,
      current + result.confidence * getSourcePriority(result.source)
    );
  }

  const preferredCurrency = [...currencyScores.entries()].sort(
    (a, b) => b[1] - a[1]
  )[0]?.[0];

  if (!preferredCurrency) return results;

  return [
    ...withCurrency.filter((result) => result.currency === preferredCurrency),
    ...withoutCurrency
  ];
}

function getSourcePriority(sourceName: string): number {
  const source = sources.find((entry) => entry.name === sourceName);
  return source?.priority ?? 50;
}

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
  if (!allowStale && !isCacheValid(cache.updatedAt)) return null;

  return {
    price: Number(cache.price),
    currency: cache.currency as SupportedCurrency | null,
    source: cache.source,
    confidence: cache.confidence
  };
}

export async function refreshValuation(
  item: Item
): Promise<ValuationResult | null> {
  const key = buildCacheKey(item);

  const { valuation, attempts, marketDataResults } =
    await scrapeValuation(item);

  await logScraperAttempts(item, attempts);
  await saveSourceMarketData(item, marketDataResults);

  if (!valuation) return null;

  const now = new Date();

  await prisma.$transaction([
    prisma.priceCache.upsert({
      where: { key },
      update: {
        price: valuation.price,
        currency: valuation.currency ?? null,
        source: valuation.source,
        confidence: valuation.confidence,
        updatedAt: now
      },
      create: {
        key,
        price: valuation.price,
        currency: valuation.currency ?? null,
        source: valuation.source,
        confidence: valuation.confidence,
        updatedAt: now
      }
    }),

    prisma.item.update({
      where: { id: item.id },
      data: {
        marketValue: valuation.price,
        marketCurrency: valuation.currency ?? null,
        valuationSource: valuation.source,
        valuationConfidence: valuation.confidence,
        lastValuationAt: now
      }
    }),

    prisma.itemValuationSnapshot.create({
      data: {
        itemId: item.id,
        marketValue: valuation.price,
        currency: valuation.currency ?? null,
        source: valuation.source,
        confidence: valuation.confidence,
        recordedAt: now
      }
    })
  ]);

  console.log("[valuation] Updated:", {
    itemId: item.id,
    price: valuation.price,
    currency: valuation.currency,
    source: valuation.source
  });

  return valuation;
}

export async function needsValuationRefresh(item: Item): Promise<boolean> {
  const key = buildCacheKey(item);

  const cache = await prisma.priceCache.findUnique({
    where: { key }
  });

  if (!cache) return true;

  return !isCacheValid(cache.updatedAt);
}