import { Item } from "@prisma/client";
import { ScraperSourceResult } from "../scraper.types";
import { normalizeText, similarityScore } from "../utils";

type ScryfallSearchResponse = {
  object: string;
  total_cards?: number;
  has_more?: boolean;
  data?: ScryfallCard[];
};

type ScryfallCard = {
  id: string;
  name: string;
  lang?: string;
  released_at?: string;
  uri?: string;
  scryfall_uri?: string;
  layout?: string;
  highres_image?: boolean;
  image_status?: string;

  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  colors?: string[];
  color_identity?: string[];

  set?: string;
  set_name?: string;
  set_type?: string;
  collector_number?: string;
  rarity?: string;

  artist?: string;
  border_color?: string;
  frame?: string;
  full_art?: boolean;
  textless?: boolean;
  booster?: boolean;

  prices?: {
    usd?: string | null;
    usd_foil?: string | null;
    usd_etched?: string | null;
    eur?: string | null;
    eur_foil?: string | null;
    tix?: string | null;
  };

  purchase_uris?: {
    tcgplayer?: string;
    cardmarket?: string;
    cardhoarder?: string;
  };

  image_uris?: {
    small?: string;
    normal?: string;
    large?: string;
    png?: string;
    art_crop?: string;
    border_crop?: string;
  };

  card_faces?: Array<{
    name?: string;
    mana_cost?: string;
    type_line?: string;
    oracle_text?: string;
    power?: string;
    toughness?: string;
    image_uris?: {
      small?: string;
      normal?: string;
      large?: string;
      png?: string;
      art_crop?: string;
      border_crop?: string;
    };
  }>;
};

type ParsedMagicQuery = {
  cleanName: string;
  setCode: string | null;
  setName: string | null;
  collectorNumber: string | null;
};

type ScoredScryfallCard = {
  card: ScryfallCard;
  score: number;
};

type ScryfallPricing = {
  price: number | null;
  currency: "EUR" | "USD" | null;
  priceBasis: string;
};

const BASE_URL = "https://api.scryfall.com";
const REQUEST_TIMEOUT_MS = 15000;

export async function getScryfallPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (item.category !== "tcg") return null;
  if (normalizePlatform(item.platform) !== "magic") return null;

  const query = String(item.name || "").trim();
  if (!query) return null;

  const parsed = parseMagicQuery(item);

  console.log("🟪 SCRYFALL called:", {
    itemId: item.id,
    name: item.name,
    platform: item.platform,
    region: item.region,
    parsed
  });

  const cards = await searchScryfallCards(parsed);

  if (cards.length === 0) {
    console.log("🟪 SCRYFALL no cards found:", parsed);
    return null;
  }

  const best = pickBestScryfallCard(parsed, cards);

  if (!best) {
    console.log("🟪 SCRYFALL cards found but no reliable match:", {
      parsed,
      count: cards.length
    });

    return null;
  }

  const pricing = extractScryfallPricing(best.card);
  const confidence = computeConfidence(parsed, best);
  const matchedTitle = buildMatchedTitle(best.card);
  const matchedUrl =
    best.card.scryfall_uri ??
    best.card.purchase_uris?.cardmarket ??
    best.card.purchase_uris?.tcgplayer ??
    undefined;

  if (!pricing.price || pricing.price <= 0) {
    console.log("🟪 SCRYFALL matched card without price:", {
      id: best.card.id,
      name: best.card.name,
      set: best.card.set_name,
      setCode: best.card.set,
      collectorNumber: best.card.collector_number,
      prices: best.card.prices
    });

    return {
      price: 0,
      currency: pricing.currency,
      source: "scryfall",
      confidence,
      matchedTitle,
      matchedUrl,
      query,
      metadata: buildScryfallMetadata(best.card, parsed, pricing, cards)
    };
  }

  console.log("🟪 SCRYFALL selected:", {
    id: best.card.id,
    title: matchedTitle,
    price: pricing.price,
    currency: pricing.currency,
    confidence,
    priceBasis: pricing.priceBasis,
    url: matchedUrl
  });

  return {
    price: Number(pricing.price.toFixed(2)),
    currency: pricing.currency,
    source: "scryfall",
    confidence,
    matchedTitle,
    matchedUrl,
    query,
    metadata: buildScryfallMetadata(best.card, parsed, pricing, cards)
  };
}

async function searchScryfallCards(
  parsed: ParsedMagicQuery
): Promise<ScryfallCard[]> {
  const queries = buildScryfallQueries(parsed);
  const allCards: ScryfallCard[] = [];
  const seen = new Set<string>();

  for (const q of queries) {
    const url = `${BASE_URL}/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released`;

    console.log("🟪 SCRYFALL searching:", {
      q,
      url
    });

    const response = await fetchScryfall<ScryfallSearchResponse>(url);

    for (const card of response?.data ?? []) {
      if (!card.id || seen.has(card.id)) continue;

      seen.add(card.id);
      allCards.push(card);
    }

    if (allCards.length > 0 && (parsed.collectorNumber || parsed.setCode)) {
      break;
    }
  }

  return allCards;
}

function buildScryfallQueries(parsed: ParsedMagicQuery): string[] {
  const queries: string[] = [];
  const escapedName = escapeScryfallValue(parsed.cleanName);

  if (parsed.collectorNumber && parsed.setCode) {
    queries.push(`!"${escapedName}" set:${parsed.setCode.toLowerCase()} cn:${parsed.collectorNumber}`);
  }

  if (parsed.setCode) {
    queries.push(`!"${escapedName}" set:${parsed.setCode.toLowerCase()}`);
  }

  if (parsed.collectorNumber) {
    queries.push(`!"${escapedName}" cn:${parsed.collectorNumber}`);
  }

  queries.push(`!"${escapedName}"`);
  queries.push(escapedName);

  return [...new Set(queries)];
}

async function fetchScryfall<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "geek-inventory-api/1.0"
      }
    });

    if (!res.ok) {
      console.log("❌ SCRYFALL fetch failed:", {
        status: res.status,
        url
      });

      return null;
    }

    return (await res.json()) as T;
  } catch (err) {
    console.log("❌ SCRYFALL fetch error:", {
      url,
      error: err
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseMagicQuery(item: Item): ParsedMagicQuery {
  const rawName = String(item.name || "").trim();
  const region = String(item.region || "").trim();
  const platform = String(item.platform || "").trim();

  const parenthesisMatch = rawName.match(/\(([^)]+)\)/);
  const content = parenthesisMatch?.[1] ?? "";

  const parts = content
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const parenthesisSetCode =
    parts.find(
      (part) =>
        /^[A-Z0-9]{2,8}$/i.test(part) &&
        !/^\d+[a-zA-Z]?$/i.test(part) &&
        normalizePlatform(part) !== "magic"
    ) ?? null;

  const parenthesisCollector =
    parts.find((part) => /^\d+[a-zA-Z]?$/i.test(part)) ?? null;

  const regionIsCollector = /^\d+[a-zA-Z]?$/i.test(region);
  const regionIsSetCode =
    /^[A-Z0-9]{2,8}$/i.test(region) &&
    !regionIsCollector &&
    normalizePlatform(region) !== "magic";

  const setCode =
    parenthesisSetCode ||
    (regionIsSetCode ? region : null) ||
    null;

  const setName =
    region && !regionIsCollector && !regionIsSetCode && normalizePlatform(region) !== "magic"
      ? region
      : null;

  const collectorNumber =
    parenthesisCollector ||
    (regionIsCollector ? region : null) ||
    rawName.match(/\b(\d+[a-zA-Z]?)\b/)?.[1] ||
    null;

  const cleanName = rawName
    .replace(/\([^)]*\)/g, "")
    .replace(/\b\d+[a-zA-Z]?\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    cleanName: cleanName || rawName,
    setCode: setCode ? normalizeSetCode(setCode) : null,
    setName,
    collectorNumber: collectorNumber ? normalizeCollectorNumber(collectorNumber) : null
  };
}

function pickBestScryfallCard(
  parsed: ParsedMagicQuery,
  cards: ScryfallCard[]
): ScoredScryfallCard | null {
  const wantedName = normalizeMagicText(parsed.cleanName);

  const scored = cards.map((card) => {
    const cardName = normalizeMagicText(card.name);
    const setCode = normalizeSetCode(card.set ?? "");
    const setName = normalizeMagicText(card.set_name ?? "");
    const collectorNumber = normalizeCollectorNumber(card.collector_number ?? "");

    let score = similarityScore(wantedName, cardName);

    if (cardName === wantedName) score += 0.55;
    if (cardName.includes(wantedName)) score += 0.25;

    if (
      parsed.collectorNumber &&
      collectorNumber === parsed.collectorNumber
    ) {
      score += 0.4;
    }

    if (parsed.setCode && setCode === parsed.setCode) {
      score += 0.35;
    }

    if (
      parsed.setName &&
      setName.includes(normalizeMagicText(parsed.setName))
    ) {
      score += 0.25;
    }

    if (card.prices?.eur || card.prices?.usd || card.prices?.usd_foil) {
      score += 0.08;
    }

    return {
      card,
      score: Number(score.toFixed(4))
    };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log(
    "🟪 SCRYFALL top:",
    scored.slice(0, 8).map((entry) => ({
      id: entry.card.id,
      name: entry.card.name,
      set: entry.card.set_name,
      setCode: entry.card.set,
      collectorNumber: entry.card.collector_number,
      rarity: entry.card.rarity,
      score: Number(entry.score.toFixed(2))
    }))
  );

  const best = scored[0];

  if (!best) return null;

  const minScore = parsed.collectorNumber || parsed.setCode ? 0.75 : 0.65;

  if (best.score < minScore) return null;

  return best;
}

function extractScryfallPricing(card: ScryfallCard): ScryfallPricing {
  const prices = card.prices;

  if (prices?.eur) {
    const price = parsePrice(prices.eur);

    if (price && price > 0) {
      return {
        price,
        currency: "EUR",
        priceBasis: "scryfall.prices.eur"
      };
    }
  }

  if (prices?.usd) {
    const price = parsePrice(prices.usd);

    if (price && price > 0) {
      return {
        price,
        currency: "USD",
        priceBasis: "scryfall.prices.usd"
      };
    }
  }

  if (prices?.usd_foil) {
    const price = parsePrice(prices.usd_foil);

    if (price && price > 0) {
      return {
        price,
        currency: "USD",
        priceBasis: "scryfall.prices.usd_foil"
      };
    }
  }

  if (prices?.usd_etched) {
    const price = parsePrice(prices.usd_etched);

    if (price && price > 0) {
      return {
        price,
        currency: "USD",
        priceBasis: "scryfall.prices.usd_etched"
      };
    }
  }

  return {
    price: null,
    currency: null,
    priceBasis: "none"
  };
}

function computeConfidence(
  parsed: ParsedMagicQuery,
  scored: ScoredScryfallCard
): number {
  const wantedName = normalizeMagicText(parsed.cleanName);
  const matchedName = normalizeMagicText(scored.card.name);

  let confidence = 0.48 + similarityScore(wantedName, matchedName) * 0.25;

  if (matchedName === wantedName) confidence += 0.2;

  if (
    parsed.collectorNumber &&
    normalizeCollectorNumber(scored.card.collector_number ?? "") === parsed.collectorNumber
  ) {
    confidence += 0.1;
  }

  if (
    parsed.setCode &&
    normalizeSetCode(scored.card.set ?? "") === parsed.setCode
  ) {
    confidence += 0.08;
  }

  if (scored.card.prices?.eur || scored.card.prices?.usd) {
    confidence += 0.05;
  }

  return Math.max(0.5, Math.min(0.95, Number(confidence.toFixed(2))));
}

function buildMatchedTitle(card: ScryfallCard): string {
  const setLabel = card.set ? card.set.toUpperCase() : "";
  const collector = card.collector_number || "";

  const parts = [
    card.name,
    setLabel || collector ? `(${setLabel} ${collector})` : "",
    card.set_name ? `- ${card.set_name}` : ""
  ];

  return parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
}

function buildScryfallMetadata(
  card: ScryfallCard,
  parsed: ParsedMagicQuery,
  pricing: ScryfallPricing,
  cards: ScryfallCard[]
): Record<string, unknown> {
  return {
    provider: "scryfall",
    scryfallId: card.id,

    name: card.name,
    lang: card.lang ?? null,
    releasedAt: card.released_at ?? null,
    layout: card.layout ?? null,

    manaCost: card.mana_cost ?? null,
    cmc: card.cmc ?? null,
    typeLine: card.type_line ?? null,
    oracleText: card.oracle_text ?? null,
    power: card.power ?? null,
    toughness: card.toughness ?? null,
    colors: card.colors ?? null,
    colorIdentity: card.color_identity ?? null,

    setCode: card.set ?? null,
    setName: card.set_name ?? null,
    setType: card.set_type ?? null,
    collectorNumber: card.collector_number ?? null,
    rarity: card.rarity ?? null,

    artist: card.artist ?? null,
    borderColor: card.border_color ?? null,
    frame: card.frame ?? null,
    fullArt: card.full_art ?? null,
    textless: card.textless ?? null,
    booster: card.booster ?? null,

    requestedName: parsed.cleanName,
    requestedSetCode: parsed.setCode,
    requestedSetName: parsed.setName,
    requestedCollectorNumber: parsed.collectorNumber,

    hasPrice: Boolean(pricing.price && pricing.price > 0),
    priceBasis: pricing.priceBasis,
    currency: pricing.currency,

    prices: card.prices ?? null,
    purchaseUris: card.purchase_uris ?? null,

    imageSmall: card.image_uris?.small ?? card.card_faces?.[0]?.image_uris?.small ?? null,
    imageNormal: card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal ?? null,
    imageLarge: card.image_uris?.large ?? card.card_faces?.[0]?.image_uris?.large ?? null,

    scryfallUrl: card.scryfall_uri ?? null,

    alternatives: cards.slice(0, 10).map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      setCode: candidate.set ?? null,
      setName: candidate.set_name ?? null,
      collectorNumber: candidate.collector_number ?? null,
      rarity: candidate.rarity ?? null,
      prices: candidate.prices ?? null,
      scryfallUrl: candidate.scryfall_uri ?? null
    }))
  };
}

function parsePrice(value: string | null | undefined): number | null {
  const parsed = Number(String(value || "").replace(",", "."));

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizePlatform(value: string | null): string | null {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();

  if (!normalized) return null;

  if (
    normalized === "magic" ||
    normalized === "mtg" ||
    normalized === "magicthegathering"
  ) {
    return "magic";
  }

  return normalized;
}

function normalizeMagicText(value: string): string {
  return normalizeText(value)
    .replace(/\bmagic\b/g, "")
    .replace(/\bmtg\b/g, "")
    .replace(/\bthe gathering\b/g, "")
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

function normalizeCollectorNumber(value: string): string {
  return String(value || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .trim();
}

function escapeScryfallValue(value: string): string {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .trim();
}