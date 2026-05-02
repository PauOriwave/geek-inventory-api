import { Item } from "@prisma/client";
import { ScraperSourceResult } from "../scraper.types";
import { normalizeText, similarityScore } from "../utils";

type PokemonTcgApiResponse = {
  data?: PokemonTcgCard[];
};

type PokemonTcgCard = {
  id: string;
  name: string;
  supertype?: string;
  subtypes?: string[];
  hp?: string;
  types?: string[];
  evolvesFrom?: string;
  number?: string;
  artist?: string;
  rarity?: string;
  flavorText?: string;
  nationalPokedexNumbers?: number[];
  set?: {
    id?: string;
    name?: string;
    series?: string;
    printedTotal?: number;
    total?: number;
    ptcgoCode?: string;
    releaseDate?: string;
  };
  images?: {
    small?: string;
    large?: string;
  };
  tcgplayer?: {
    url?: string;
    updatedAt?: string;
    prices?: Record<
      string,
      {
        low?: number;
        mid?: number;
        high?: number;
        market?: number;
        directLow?: number;
      }
    >;
  };
  cardmarket?: {
    url?: string;
    updatedAt?: string;
    prices?: {
      averageSellPrice?: number;
      lowPrice?: number;
      trendPrice?: number;
      germanProLow?: number;
      suggestedPrice?: number;
      reverseHoloSell?: number;
      reverseHoloLow?: number;
      reverseHoloTrend?: number;
      lowPriceExPlus?: number;
      avg1?: number;
      avg7?: number;
      avg30?: number;
    };
  };
};

type ParsedPokemonQuery = {
  cleanName: string;
  setCode: string | null;
  cardNumber: string | null;
};

type ScoredPokemonCard = {
  card: PokemonTcgCard;
  score: number;
};

type PokemonPricing = {
  price: number | null;
  priceBasis: string;
  currency: "EUR" | "USD" | null;
};

const BASE_URL = "https://api.pokemontcg.io/v2";
const REQUEST_TIMEOUT_MS = 15000;

export async function getPokemonTcgPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (item.category !== "tcg") return null;

  const query = String(item.name || "").trim();
  if (!query) return null;

  const parsed = parsePokemonQuery(item);

  console.log("🟨 PTCG called:", {
    itemId: item.id,
    name: item.name,
    platform: item.platform,
    region: item.region,
    parsed
  });

  const cards = await searchPokemonCards(parsed);

  if (cards.length === 0) {
    console.log("🟨 PTCG no cards found:", parsed);
    return null;
  }

  const best = pickBestPokemonCard(parsed, cards);

  if (!best) {
    console.log("🟨 PTCG cards found but no reliable match:", {
      parsed,
      count: cards.length
    });

    return null;
  }

  const pricing = extractPokemonPricing(best.card);
  const confidence = computeConfidence(parsed, best);
  const matchedTitle = buildMatchedTitle(best.card);

  const matchedUrl =
    best.card.cardmarket?.url ??
    best.card.tcgplayer?.url ??
    undefined;

  if (!pricing.price || pricing.price <= 0) {
    console.log("🟨 PTCG matched card without price:", {
      id: best.card.id,
      name: best.card.name,
      set: best.card.set?.name,
      setCode: best.card.set?.ptcgoCode,
      number: best.card.number
    });

    return {
      price: 0,
      source: "pokemon_tcg_api",
      confidence,
      matchedTitle,
      matchedUrl,
      query,
      metadata: buildPokemonMetadata(best.card, parsed, pricing, cards)
    };
  }

  console.log("🟨 PTCG selected:", {
    id: best.card.id,
    title: matchedTitle,
    price: pricing.price,
    confidence,
    priceBasis: pricing.priceBasis,
    url: matchedUrl
  });

  return {
    price: Number(pricing.price.toFixed(2)),
    source: "pokemon_tcg_api",
    confidence,
    matchedTitle,
    matchedUrl,
    query,
    metadata: buildPokemonMetadata(best.card, parsed, pricing, cards)
  };
}

async function searchPokemonCards(
  parsed: ParsedPokemonQuery
): Promise<PokemonTcgCard[]> {
  const queries = buildApiQueries(parsed);
  const allCards: PokemonTcgCard[] = [];
  const seen = new Set<string>();

  for (const q of queries) {
    const url = `${BASE_URL}/cards?q=${encodeURIComponent(q)}&pageSize=25`;

    console.log("🟨 PTCG Searching:", {
      q,
      url
    });

    const response = await fetchPokemonApi(url);

    for (const card of response?.data ?? []) {
      if (!card.id || seen.has(card.id)) continue;

      seen.add(card.id);
      allCards.push(card);
    }

    if (allCards.length > 0 && parsed.cardNumber) {
      break;
    }
  }

  return allCards;
}

function buildApiQueries(parsed: ParsedPokemonQuery): string[] {
  const queries: string[] = [];
  const escapedName = escapeLuceneValue(parsed.cleanName);

  if (parsed.cardNumber && parsed.setCode) {
    queries.push(`name:"${escapedName}" number:${parsed.cardNumber} set.ptcgoCode:${parsed.setCode}`);
    queries.push(`name:"${escapedName}" number:${parsed.cardNumber} set.id:${parsed.setCode.toLowerCase()}`);
    queries.push(`name:"${escapedName}" number:${parsed.cardNumber}`);
  }

  if (parsed.cardNumber) {
    queries.push(`name:"${escapedName}" number:${parsed.cardNumber}`);
  }

  if (parsed.setCode) {
    queries.push(`name:"${escapedName}" set.ptcgoCode:${parsed.setCode}`);
    queries.push(`name:"${escapedName}" set.id:${parsed.setCode.toLowerCase()}`);
  }

  queries.push(`name:"${escapedName}"`);

  return [...new Set(queries)];
}

async function fetchPokemonApi(
  url: string
): Promise<PokemonTcgApiResponse | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      Accept: "application/json"
    };

    if (process.env.POKEMON_TCG_API_KEY) {
      headers["X-Api-Key"] = process.env.POKEMON_TCG_API_KEY;
    }

    const res = await fetch(url, {
      signal: controller.signal,
      headers
    });

    if (!res.ok) {
      console.log("❌ PTCG fetch failed:", {
        status: res.status,
        url
      });

      return null;
    }

    return (await res.json()) as PokemonTcgApiResponse;
  } catch (err) {
    console.log("❌ PTCG fetch error:", {
      url,
      error: err
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parsePokemonQuery(item: Item): ParsedPokemonQuery {
  const rawName = String(item.name || "").trim();
  const platform = String(item.platform || "").trim();
  const region = String(item.region || "").trim();

  const parenthesisMatch = rawName.match(/\(([^)]+)\)/);
  const parenthesisContent = parenthesisMatch?.[1] ?? "";

  const parenthesisParts = parenthesisContent
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const possibleSetCode =
    platform ||
    parenthesisParts.find((part) => /^[A-Z0-9]{2,8}$/i.test(part)) ||
    null;

  const possibleCardNumber =
    region ||
    parenthesisParts.find((part) => /^\d+[a-zA-Z]?\/?\d*[a-zA-Z]?$/.test(part)) ||
    rawName.match(/\b(\d+[a-zA-Z]?\/?\d*[a-zA-Z]?)\b/)?.[1] ||
    null;

  const cleanName = rawName
    .replace(/\([^)]*\)/g, "")
    .replace(/\b\d+[a-zA-Z]?\/?\d*[a-zA-Z]?\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    cleanName: cleanName || rawName,
    setCode: possibleSetCode ? normalizeSetCode(possibleSetCode) : null,
    cardNumber: possibleCardNumber ? normalizeCardNumber(possibleCardNumber) : null
  };
}

function pickBestPokemonCard(
  parsed: ParsedPokemonQuery,
  cards: PokemonTcgCard[]
): ScoredPokemonCard | null {
  const wantedName = normalizePokemonText(parsed.cleanName);

  const scored = cards.map((card) => {
    const cardName = normalizePokemonText(card.name);
    const setCode = normalizeSetCode(card.set?.ptcgoCode ?? "");
    const setId = normalizeSetCode(card.set?.id ?? "");
    const number = normalizeCardNumber(card.number ?? "");

    let score = similarityScore(wantedName, cardName);

    if (cardName === wantedName) score += 0.4;
    if (cardName.includes(wantedName)) score += 0.2;

    if (parsed.cardNumber && number === parsed.cardNumber) {
      score += 0.45;
    }

    if (
      parsed.setCode &&
      (setCode === parsed.setCode || setId === parsed.setCode)
    ) {
      score += 0.35;
    }

    if (card.cardmarket?.prices || card.tcgplayer?.prices) {
      score += 0.08;
    }

    return {
      card,
      score: Number(score.toFixed(4))
    };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log(
    "🟨 PTCG top:",
    scored.slice(0, 8).map((entry) => ({
      id: entry.card.id,
      name: entry.card.name,
      set: entry.card.set?.name,
      setCode: entry.card.set?.ptcgoCode,
      setId: entry.card.set?.id,
      number: entry.card.number,
      score: Number(entry.score.toFixed(2))
    }))
  );

  const best = scored[0];

  if (!best) return null;

  const minScore = parsed.cardNumber ? 0.65 : 0.55;

  if (best.score < minScore) return null;

  return best;
}

function extractPokemonPricing(card: PokemonTcgCard): PokemonPricing {
  const cardmarketPrices = card.cardmarket?.prices;

  if (cardmarketPrices?.trendPrice && cardmarketPrices.trendPrice > 0) {
    return {
      price: cardmarketPrices.trendPrice,
      priceBasis: "cardmarket.trendPrice",
      currency: "EUR"
    };
  }

  if (cardmarketPrices?.averageSellPrice && cardmarketPrices.averageSellPrice > 0) {
    return {
      price: cardmarketPrices.averageSellPrice,
      priceBasis: "cardmarket.averageSellPrice",
      currency: "EUR"
    };
  }

  if (cardmarketPrices?.avg30 && cardmarketPrices.avg30 > 0) {
    return {
      price: cardmarketPrices.avg30,
      priceBasis: "cardmarket.avg30",
      currency: "EUR"
    };
  }

  if (cardmarketPrices?.avg7 && cardmarketPrices.avg7 > 0) {
    return {
      price: cardmarketPrices.avg7,
      priceBasis: "cardmarket.avg7",
      currency: "EUR"
    };
  }

  if (cardmarketPrices?.lowPrice && cardmarketPrices.lowPrice > 0) {
    return {
      price: cardmarketPrices.lowPrice,
      priceBasis: "cardmarket.lowPrice",
      currency: "EUR"
    };
  }

  const tcgplayerPrice = extractBestTcgPlayerPrice(card);

  if (tcgplayerPrice.price) {
    return {
      price: tcgplayerPrice.price,
      priceBasis: tcgplayerPrice.priceBasis,
      currency: "USD"
    };
  }

  return {
    price: null,
    priceBasis: "none",
    currency: null
  };
}

function extractBestTcgPlayerPrice(card: PokemonTcgCard): {
  price: number | null;
  priceBasis: string;
} {
  const prices = card.tcgplayer?.prices;

  if (!prices) {
    return {
      price: null,
      priceBasis: "none"
    };
  }

  const preferredVariants = [
    "normal",
    "holofoil",
    "reverseHolofoil",
    "1stEditionHolofoil",
    "unlimitedHolofoil"
  ];

  for (const variant of preferredVariants) {
    const entry = prices[variant];

    if (entry?.market && entry.market > 0) {
      return {
        price: entry.market,
        priceBasis: `tcgplayer.${variant}.market`
      };
    }

    if (entry?.mid && entry.mid > 0) {
      return {
        price: entry.mid,
        priceBasis: `tcgplayer.${variant}.mid`
      };
    }

    if (entry?.low && entry.low > 0) {
      return {
        price: entry.low,
        priceBasis: `tcgplayer.${variant}.low`
      };
    }
  }

  for (const [variant, entry] of Object.entries(prices)) {
    if (entry?.market && entry.market > 0) {
      return {
        price: entry.market,
        priceBasis: `tcgplayer.${variant}.market`
      };
    }

    if (entry?.mid && entry.mid > 0) {
      return {
        price: entry.mid,
        priceBasis: `tcgplayer.${variant}.mid`
      };
    }

    if (entry?.low && entry.low > 0) {
      return {
        price: entry.low,
        priceBasis: `tcgplayer.${variant}.low`
      };
    }
  }

  return {
    price: null,
    priceBasis: "none"
  };
}

function computeConfidence(
  parsed: ParsedPokemonQuery,
  scored: ScoredPokemonCard
): number {
  const wantedName = normalizePokemonText(parsed.cleanName);
  const matchedName = normalizePokemonText(scored.card.name);

  let confidence = 0.45 + similarityScore(wantedName, matchedName) * 0.25;

  if (matchedName === wantedName) confidence += 0.15;

  if (
    parsed.cardNumber &&
    normalizeCardNumber(scored.card.number ?? "") === parsed.cardNumber
  ) {
    confidence += 0.15;
  }

  const matchedSetCode = normalizeSetCode(scored.card.set?.ptcgoCode ?? "");
  const matchedSetId = normalizeSetCode(scored.card.set?.id ?? "");

  if (
    parsed.setCode &&
    (matchedSetCode === parsed.setCode || matchedSetId === parsed.setCode)
  ) {
    confidence += 0.1;
  }

  if (scored.card.cardmarket?.prices || scored.card.tcgplayer?.prices) {
    confidence += 0.05;
  }

  return Math.max(0.45, Math.min(0.95, Number(confidence.toFixed(2))));
}

function buildMatchedTitle(card: PokemonTcgCard): string {
  const setLabel = card.set?.ptcgoCode || card.set?.id || "";
  const numberLabel = card.number || "";

  const parts = [
    card.name,
    setLabel || numberLabel ? `(${setLabel} ${numberLabel})` : "",
    card.set?.name ? `- ${card.set.name}` : ""
  ];

  return parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
}

function buildPokemonMetadata(
  card: PokemonTcgCard,
  parsed: ParsedPokemonQuery,
  pricing: PokemonPricing,
  cards: PokemonTcgCard[]
): Record<string, unknown> {
  return {
    provider: "pokemon_tcg_api",
    pokemonTcgId: card.id,

    name: card.name,
    supertype: card.supertype ?? null,
    subtypes: card.subtypes ?? null,
    hp: card.hp ?? null,
    types: card.types ?? null,
    evolvesFrom: card.evolvesFrom ?? null,

    setId: card.set?.id ?? null,
    setName: card.set?.name ?? null,
    setSeries: card.set?.series ?? null,
    setCode: card.set?.ptcgoCode ?? null,
    setPrintedTotal: card.set?.printedTotal ?? null,
    setTotal: card.set?.total ?? null,
    setReleaseDate: card.set?.releaseDate ?? null,

    requestedSetCode: parsed.setCode,
    requestedCardNumber: parsed.cardNumber,
    cardNumber: card.number ?? null,

    rarity: card.rarity ?? null,
    artist: card.artist ?? null,
    flavorText: card.flavorText ?? null,
    nationalPokedexNumbers: card.nationalPokedexNumbers ?? null,

    imageSmall: card.images?.small ?? null,
    imageLarge: card.images?.large ?? null,

    hasPrice: Boolean(pricing.price && pricing.price > 0),
    priceBasis: pricing.priceBasis,
    currency: pricing.currency,

    cardmarket: {
      url: card.cardmarket?.url ?? null,
      updatedAt: card.cardmarket?.updatedAt ?? null,
      prices: card.cardmarket?.prices ?? null
    },

    tcgplayer: {
      url: card.tcgplayer?.url ?? null,
      updatedAt: card.tcgplayer?.updatedAt ?? null,
      prices: card.tcgplayer?.prices ?? null
    },

    alternatives: buildAlternatives(cards, parsed)
  };
}

function buildAlternatives(
  cards: PokemonTcgCard[],
  parsed: ParsedPokemonQuery
) {
  return cards.slice(0, 10).map((card) => ({
    id: card.id,
    name: card.name,
    setId: card.set?.id ?? null,
    setName: card.set?.name ?? null,
    setCode: card.set?.ptcgoCode ?? null,
    number: card.number ?? null,
    rarity: card.rarity ?? null,
    imageSmall: card.images?.small ?? null,
    imageLarge: card.images?.large ?? null,
    cardmarketUrl: card.cardmarket?.url ?? null,
    tcgplayerUrl: card.tcgplayer?.url ?? null,
    cardmarketPrices: card.cardmarket?.prices ?? null,
    tcgplayerPrices: card.tcgplayer?.prices ?? null,
    match: {
      requestedName: parsed.cleanName,
      requestedSetCode: parsed.setCode,
      requestedCardNumber: parsed.cardNumber
    }
  }));
}

function normalizePokemonText(value: string): string {
  return normalizeText(value)
    .replace(/\bpokemon\b/g, "")
    .replace(/\bpokémon\b/g, "")
    .replace(/\btcg\b/g, "")
    .replace(/\bcard\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSetCode(value: string): string {
  return String(value || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .trim();
}

function normalizeCardNumber(value: string): string {
  return String(value || "")
    .split("/")[0]
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .trim();
}

function escapeLuceneValue(value: string): string {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .trim();
}