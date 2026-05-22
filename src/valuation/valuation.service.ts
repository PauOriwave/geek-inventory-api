import { Item, Prisma } from "@prisma/client";
import prisma from "../prisma/client";

import { getPriceChartingVideogamePrice } from "./sources/pricecharting-videogame.source";
import { getPriceChartingComicPrice } from "./sources/pricecharting-comic.source";
import { getPriceChartingGuidePrice } from "./sources/pricecharting-guide.source";
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
import { getKurogamiMerchPrice } from "./sources/kurogami-merch.source";
import { getNinNinGamePrice } from "./sources/nin-nin-game.source";
import { getTodocoleccionPrice } from "./sources/todocoleccion.source";

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

type PriceRole = "market" | "historical" | "listing" | "retail" | "catalog";
type LiquidityLevel = "low" | "medium" | "high";

const MIN_CONFIDENCE_FOR_VALUATION = 0.5;
const TCG_DUNGEON_MARVELS_MIN_CONFIDENCE = 0.8;
const MERCH_MIN_CONFIDENCE = 0.65;
const DUNGEON_MARVELS_MERCH_MIN_CONFIDENCE = 0.6;
const NIN_NIN_GAME_MERCH_MIN_CONFIDENCE = 0.55;
const TODOCOLECCION_MIN_CONFIDENCE = 0.45;
const PRICECHARTING_GUIDE_MIN_CONFIDENCE = 0.55;
const SUSPICIOUS_GUIDE_PUBLISHER_PRICE_LIMIT = 1.5;

const CACHE_TTL_HOURS = 24;

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
    categories: ["book", "guide", "magazine"],
    handler: getTodosTusLibrosPrice
  },
  {
    name: "la_central",
    priority: 76,
    categories: ["book", "guide", "magazine"],
    handler: getLaCentralPrice
  },
  {
    name: "pricecharting_comic",
    priority: 89,
    categories: ["comic"],
    handler: getPriceChartingComicPrice
  },
  {
    name: "pricecharting_guide",
    priority: 96,
    categories: ["guide"],
    handler: getPriceChartingGuidePrice
  },
  {
    name: "norma_comics",
    priority: 86,
    categories: ["comic", "book", "guide", "magazine"],
    handler: getNormaComicsPrice
  },
  {
    name: "todocoleccion",
    priority: 93,
    categories: ["guide", "magazine", "merch"],
    handler: getTodocoleccionPrice
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
    name: "kurogami_merch",
    priority: 89,
    categories: ["merch"],
    handler: getKurogamiMerchPrice
  },
  {
    name: "nin_nin_game",
    priority: 87,
    categories: ["figure", "merch"],
    handler: getNinNinGamePrice
  },
  {
    name: "dungeon_marvels",
    priority: 86,
    categories: [
      "boardgame",
      "miniature",
      "comic",
      "tcg",
      "figure",
      "lego",
      "merch"
    ],
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

function getSourcesForItem(item: Item): SourceDefinition[] {
  const category = normalizeCategory(item.category);

  const categorySources = sources.filter((source) =>
    source.categories.includes(category)
  );

  if (category === "figure") {
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
      ["dungeon_marvels", "goblin_trader", "nin_nin_game"].includes(
        source.name
      )
    );
  }

  if (category === "merch") {
    return categorySources.filter((source) =>
      [
        "todocoleccion",
        "kurogami_merch",
        "nin_nin_game",
        "dungeon_marvels",
        "goblin_trader"
      ].includes(source.name)
    );
  }

  if (category === "guide") {
    return categorySources.filter((source) =>
      [
        "pricecharting_guide",
        "todocoleccion",
        "todos_tus_libros",
        "la_central",
        "norma_comics"
      ].includes(source.name)
    );
  }

  if (category === "magazine") {
    return categorySources.filter((source) =>
      [
        "todocoleccion",
        "todos_tus_libros",
        "la_central",
        "norma_comics"
      ].includes(source.name)
    );
  }

  if (category !== "tcg") return categorySources;

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

  return categorySources;
}

function normalizeCategory(value: string | null): string {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();

  if (!normalized) return "merch";
  if (normalized === "other") return "merch";

  return normalized;
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
    normalized === "pop"
  ) {
    return "funko_pop";
  }

  if (normalized === "pokemon" || normalized === "pokemontcg") {
    return "pokemon";
  }

  if (normalized === "magic" || normalized === "mtg") {
    return "magic";
  }

  return normalized;
}

function normalizeValuationText(value: string): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSuspiciousGuidePriceResult(
  item: Item,
  result: ScraperSourceResult
): boolean {
  const category = normalizeCategory(item.category);

  if (category !== "guide") return false;
  if (result.source !== "pricecharting_guide") return false;
  if (result.price >= SUSPICIOUS_GUIDE_PUBLISHER_PRICE_LIMIT) return false;

  const text = normalizeValuationText(
    `${item.name} ${item.platform ?? ""} ${result.matchedTitle ?? ""}`
  );

  const hasKnownGuidePublisher =
    text.includes("piggyback") ||
    text.includes("bradygames") ||
    text.includes("brady games") ||
    text.includes("future press");

  return hasKnownGuidePublisher;
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

function getMinimumConfidenceForResult(
  item: Item,
  result: ScraperSourceResult
): number {
  const category = normalizeCategory(item.category);

  if (result.source === "pricecharting_guide") {
    return PRICECHARTING_GUIDE_MIN_CONFIDENCE;
  }

  if (result.source === "todocoleccion") {
    return TODOCOLECCION_MIN_CONFIDENCE;
  }

  if (category === "tcg" && result.source === "dungeon_marvels") {
    return TCG_DUNGEON_MARVELS_MIN_CONFIDENCE;
  }

  if (category === "merch" && result.source === "dungeon_marvels") {
    return DUNGEON_MARVELS_MERCH_MIN_CONFIDENCE;
  }

  if (category === "merch" && result.source === "nin_nin_game") {
    return NIN_NIN_GAME_MERCH_MIN_CONFIDENCE;
  }

  if (category === "merch") {
    return MERCH_MIN_CONFIDENCE;
  }

  return MIN_CONFIDENCE_FOR_VALUATION;
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

function getSourcePriority(sourceName: string): number {
  const source = sources.find((entry) => entry.name === sourceName);
  return source?.priority ?? 50;
}

function getResultPriceRole(result: ScraperSourceResult): PriceRole {
  const metadataRole = result.metadata?.priceRole ?? result.metadata?.priceType;

  if (
    metadataRole === "market" ||
    metadataRole === "historical" ||
    metadataRole === "listing" ||
    metadataRole === "retail" ||
    metadataRole === "catalog"
  ) {
    return metadataRole;
  }

  if (
    result.source === "pricecharting_videogame" ||
    result.source === "pricecharting_comic" ||
    result.source === "pricecharting_guide" ||
    result.source === "pricecharting_funko" ||
    result.source === "brickeconomy"
  ) {
    return "historical";
  }

  if (result.source === "todocoleccion") {
    return "listing";
  }

  if (
    result.source === "todos_tus_libros" ||
    result.source === "la_central" ||
    result.source === "norma_comics" ||
    result.source === "funko_europe" ||
    result.source === "kurogami_merch" ||
    result.source === "nin_nin_game" ||
    result.source === "dungeon_marvels" ||
    result.source === "goblin_trader" ||
    result.source === "juegos_mesa_redonda" ||
    result.source === "dvd_store_spain"
  ) {
    return "retail";
  }

  return "market";
}

function getResultLiquidity(result: ScraperSourceResult): LiquidityLevel {
  const metadataLiquidity = result.metadata?.liquidity;

  if (
    metadataLiquidity === "low" ||
    metadataLiquidity === "medium" ||
    metadataLiquidity === "high"
  ) {
    return metadataLiquidity;
  }

  if (
    result.source === "pricecharting_guide" ||
    result.source === "todocoleccion" ||
    result.source === "brickeconomy"
  ) {
    return "low";
  }

  if (
    result.source === "pricecharting_videogame" ||
    result.source === "pricecharting_comic" ||
    result.source === "pricecharting_funko" ||
    result.source === "cardtrader" ||
    result.source === "pokemon_tcg_api" ||
    result.source === "tcgdex" ||
    result.source === "scryfall"
  ) {
    return "medium";
  }

  return "medium";
}

function getSemanticSourceWeight(result: ScraperSourceResult): number {
  const role = getResultPriceRole(result);
  const liquidity = getResultLiquidity(result);

  let weight = 1;

  if (role === "market") weight *= 1;
  if (role === "historical") weight *= 0.92;
  if (role === "listing") weight *= 0.88;
  if (role === "retail") weight *= 0.72;
  if (role === "catalog") weight *= 0.45;

  if (liquidity === "high") weight *= 1;
  if (liquidity === "medium") weight *= 0.92;
  if (liquidity === "low") weight *= 0.82;

  if (result.source === "pricecharting_guide") {
    weight *= 0.9;
  }

  if (result.source === "todocoleccion") {
    weight *= 1.02;
  }

  return weight;
}

function getCurrencyPenalty(
  result: ScraperSourceResult,
  preferredCurrency: SupportedCurrency | null
): number {
  if (!preferredCurrency) return 1;
  if (!result.currency) return 0.92;
  if (result.currency === preferredCurrency) return 1;

  return 0.85;
}

function getPreferredCurrency(
  results: ScraperSourceResult[]
): SupportedCurrency | null {
  const counts = new Map<SupportedCurrency, number>();

  for (const result of results) {
    if (!result.currency) continue;

    counts.set(
      result.currency,
      (counts.get(result.currency) ?? 0) + 1
    );
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  return sorted[0]?.[0] ?? results[0]?.currency ?? null;
}

function filterExtremeOutliers(
  results: ScraperSourceResult[]
): ScraperSourceResult[] {
  if (results.length < 3) return results;

  const sortedPrices = results
    .map((result) => result.price)
    .filter((price) => Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b);

  if (sortedPrices.length < 3) return results;

  const median = sortedPrices[Math.floor(sortedPrices.length / 2)];

  if (!median || median <= 0) return results;

  return results.filter((result) => {
    const ratio = result.price / median;

    if (ratio > 3.5 || ratio < 0.25) {
      console.log("[valuation] Ignoring extreme outlier:", {
        source: result.source,
        price: result.price,
        median,
        ratio: Number(ratio.toFixed(2))
      });

      return false;
    }

    return true;
  });
}

function calculateWeightedValuation(
  results: ScraperSourceResult[]
): ValuationResult | null {
  if (results.length === 0) return null;

  const usableResults = filterExtremeOutliers(results);

  if (usableResults.length === 0) return null;

  const preferredCurrency = getPreferredCurrency(usableResults);

  const weightedResults = usableResults.map((result) => {
    const priority = getSourcePriority(result.source);
    const semanticWeight = getSemanticSourceWeight(result);
    const currencyPenalty = getCurrencyPenalty(result, preferredCurrency);

    const weight =
      result.confidence *
      priority *
      semanticWeight *
      currencyPenalty;

    return {
      result,
      weight,
      role: getResultPriceRole(result),
      liquidity: getResultLiquidity(result)
    };
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

  const weightedConfidence =
    weightedResults.reduce(
      (acc, entry) => acc + entry.result.confidence * entry.weight,
      0
    ) / totalWeight;

  const sourceCountBonus = Math.min(0.08, (weightedResults.length - 1) * 0.03);

  const lowLiquidityPenalty = weightedResults.every(
    (entry) => entry.liquidity === "low"
  )
    ? 0.04
    : 0;

  const singleSourcePenalty =
    weightedResults.length === 1 ? 0.03 : 0;

  const confidence = Math.min(
    0.95,
    Math.max(
      0.2,
      weightedConfidence + sourceCountBonus - lowLiquidityPenalty - singleSourcePenalty
    )
  );

  console.log(
    "[valuation] weighted results:",
    weightedResults.map((entry) => ({
      source: entry.result.source,
      price: entry.result.price,
      currency: entry.result.currency ?? null,
      confidence: entry.result.confidence,
      role: entry.role,
      liquidity: entry.liquidity,
      weight: Number(entry.weight.toFixed(2))
    }))
  );

  return {
    price: Number(weightedPrice.toFixed(2)),
    currency: preferredCurrency,
    source: mergedSources,
    confidence: Number(confidence.toFixed(2))
  };
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
    normalizedCategory: normalizeCategory(item.category),
    platform: item.platform,
    normalizedPlatform: normalizePlatform(item.platform),
    region: item.region
  });

  console.log(
    "[valuation] sources enabled:",
    activeSources.map((source) => source.name)
  );

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

      if (result?.metadata) {
        marketDataResults.push(result);
      }

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
        currency: result.currency ?? null,
        confidence: result.confidence
      });

      const requiredConfidence = getMinimumConfidenceForResult(item, result);

      if (result.confidence < requiredConfidence) {
        console.log("[valuation] Ignoring low confidence result:", {
          source: result.source,
          price: result.price,
          confidence: result.confidence,
          requiredConfidence
        });

        continue;
      }

      if (isSuspiciousGuidePriceResult(item, result)) {
        console.log("[valuation] Ignoring suspicious guide price:", {
          source: result.source,
          price: result.price,
          currency: result.currency ?? null,
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
    console.log("[valuation] No data from sources:", item.id);

    return {
      valuation: null,
      attempts,
      validResults: [],
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

export async function getValuation(
  item: Item,
  options?: { allowStale?: boolean }
): Promise<ValuationResult | null> {
  const allowStale = options?.allowStale ?? true;

  const cache = await prisma.priceCache.findUnique({
    where: {
      key: buildCacheKey(item)
    }
  });

  if (!cache) return null;

  if (!allowStale && !isCacheValid(cache.updatedAt)) {
    return null;
  }

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
  console.log("[valuation] Refresh requested:", item.id);

  const key = buildCacheKey(item);

  const { valuation, attempts, marketDataResults } =
    await scrapeValuation(item);

  await logScraperAttempts(item, attempts);
  await saveSourceMarketData(item, marketDataResults);

  if (!valuation) {
    console.log("[valuation] No data from sources:", item.id);
    return null;
  }

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
  const cache = await prisma.priceCache.findUnique({
    where: {
      key: buildCacheKey(item)
    }
  });

  if (!cache) return true;

  return !isCacheValid(cache.updatedAt);
}