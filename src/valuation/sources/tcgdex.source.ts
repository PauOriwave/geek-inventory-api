import { Item } from "@prisma/client";
import { ScraperSourceResult } from "../scraper.types";

type TcgDexCard = {
  id?: string;
  name?: string;
  localId?: string;

  set?: {
    id?: string;
    name?: string;
  };

  image?: string;
  rarity?: string;

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
      avg1?: number;
      avg7?: number;
      avg30?: number;
    };
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
      }
    >;
  };
};

type ParsedPokemonQuery = {
  cleanName: string;
  setCode: string | null;
  cardNumber: string | null;
};

const BASE_URL = "https://api.tcgdex.net/v2/en";
const REQUEST_TIMEOUT_MS = 15000;

export const getTcgDexPrice = async (
  item: Item
): Promise<ScraperSourceResult | null> => {
  if (item.category !== "tcg") return null;

  const query = String(item.name || "").trim();
  if (!query) return null;

  const parsed = parsePokemonQuery(item);

  console.log("🟦 TCGDEX called:", {
    itemId: item.id,
    name: item.name,
    parsed
  });

  const searchResults = await searchCards(parsed);

  if (searchResults.length === 0) {
    console.log("🟦 TCGDEX no cards found");
    return null;
  }

  const best = pickBest(searchResults, parsed);

  if (!best) {
    console.log("🟦 TCGDEX no reliable match");
    return null;
  }

  const pricing = extractPricing(best);

  if (!pricing.price || pricing.price <= 0) {
    console.log("🟦 TCGDEX matched but no price:", {
      id: best.id,
      name: best.name
    });

    return {
      price: 0,
      source: "tcgdex",
      confidence: 0.55,
      matchedTitle: buildTitle(best),
      matchedUrl: best.cardmarket?.url ?? best.tcgplayer?.url ?? undefined,
      query,
      metadata: {
        provider: "tcgdex",
        tcgdexId: best.id ?? null,
        name: best.name ?? null,
        localId: best.localId ?? null,
        setId: best.set?.id ?? null,
        setName: best.set?.name ?? null,
        rarity: best.rarity ?? null,
        image: best.image ?? null,
        hasPrice: false,
        pricingBasis: pricing.basis,
        cardmarket: best.cardmarket ?? null,
        tcgplayer: best.tcgplayer ?? null
      }
    };
  }

  console.log("🟦 TCGDEX selected:", {
    id: best.id,
    name: best.name,
    price: pricing.price,
    basis: pricing.basis
  });

  return {
    price: Number(pricing.price.toFixed(2)),
    source: "tcgdex",
    confidence: 0.9,
    matchedTitle: buildTitle(best),
    matchedUrl: best.cardmarket?.url ?? best.tcgplayer?.url ?? undefined,
    query,
    metadata: {
      provider: "tcgdex",
      tcgdexId: best.id ?? null,
      name: best.name ?? null,
      localId: best.localId ?? null,
      setId: best.set?.id ?? null,
      setName: best.set?.name ?? null,
      rarity: best.rarity ?? null,
      image: best.image ?? null,
      hasPrice: true,
      pricingBasis: pricing.basis,
      cardmarket: best.cardmarket ?? null,
      tcgplayer: best.tcgplayer ?? null
    }
  };
};

async function searchCards(parsed: ParsedPokemonQuery): Promise<TcgDexCard[]> {
  const url = `${BASE_URL}/cards?name=${encodeURIComponent(parsed.cleanName)}`;

  console.log("🟦 TCGDEX searching:", url);

  const data = await fetchJson<TcgDexCard[]>(url);

  if (!data) return [];

  return data;
}

function pickBest(
  cards: TcgDexCard[],
  parsed: ParsedPokemonQuery
): TcgDexCard | null {
  const wantedName = normalize(parsed.cleanName);

  const scored = cards.map((card) => {
    let score = 0;

    const name = normalize(card.name || "");
    const localId = normalize(card.localId || "");

    if (name === wantedName) score += 1;
    if (name.includes(wantedName)) score += 0.4;

    if (parsed.cardNumber && localId === normalize(parsed.cardNumber)) {
      score += 0.8;
    }

    return {
      card,
      score
    };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log(
    "🟦 TCGDEX top:",
    scored.slice(0, 5).map((x) => ({
      id: x.card.id,
      name: x.card.name,
      localId: x.card.localId,
      score: x.score
    }))
  );

  const best = scored[0];

  if (!best || best.score < 0.6) return null;

  return best.card;
}

function extractPricing(card: TcgDexCard): {
  price: number | null;
  basis: string;
} {
  const cm = card.cardmarket?.prices;

  if (cm?.trendPrice && cm.trendPrice > 0) {
    return {
      price: cm.trendPrice,
      basis: "cardmarket.trendPrice"
    };
  }

  if (cm?.averageSellPrice && cm.averageSellPrice > 0) {
    return {
      price: cm.averageSellPrice,
      basis: "cardmarket.averageSellPrice"
    };
  }

  if (cm?.avg30 && cm.avg30 > 0) {
    return {
      price: cm.avg30,
      basis: "cardmarket.avg30"
    };
  }

  if (cm?.avg7 && cm.avg7 > 0) {
    return {
      price: cm.avg7,
      basis: "cardmarket.avg7"
    };
  }

  if (cm?.lowPrice && cm.lowPrice > 0) {
    return {
      price: cm.lowPrice,
      basis: "cardmarket.lowPrice"
    };
  }

  const tcgplayer = card.tcgplayer?.prices;

  if (tcgplayer) {
    for (const [variant, values] of Object.entries(tcgplayer)) {
      if (values.market && values.market > 0) {
        return {
          price: values.market,
          basis: `tcgplayer.${variant}.market`
        };
      }

      if (values.mid && values.mid > 0) {
        return {
          price: values.mid,
          basis: `tcgplayer.${variant}.mid`
        };
      }

      if (values.low && values.low > 0) {
        return {
          price: values.low,
          basis: `tcgplayer.${variant}.low`
        };
      }
    }
  }

  return {
    price: null,
    basis: "none"
  };
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json"
      }
    });

    if (!res.ok) {
      console.log("❌ TCGDEX fetch failed:", {
        status: res.status,
        url
      });

      return null;
    }

    return (await res.json()) as T;
  } catch (err) {
    console.log("❌ TCGDEX fetch error:", {
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

  const parenthesisMatch = rawName.match(/\(([^)]+)\)/);
  const content = parenthesisMatch?.[1] ?? "";

  const parts = content
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);

  const setCode =
    parts.find((x) => /^[A-Z0-9]{2,8}$/i.test(x)) ?? null;

  const cardNumber =
    parts.find((x) => /^\d+[a-zA-Z]?$/i.test(x)) ?? null;

  const cleanName = rawName
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    cleanName,
    setCode,
    cardNumber
  };
}

function buildTitle(card: TcgDexCard) {
  return [
    card.name,
    card.localId ? `(${card.localId})` : "",
    card.set?.name ? `- ${card.set.name}` : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function normalize(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}