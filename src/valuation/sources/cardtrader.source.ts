import { Item } from "@prisma/client";
import * as cheerio from "cheerio";

import { ScraperSourceResult } from "../scraper.types";
import { normalizeText, parseEuroPrice, similarityScore } from "../utils";

type Currency = "EUR" | "USD" | "GBP";

type ParsedTcgQuery = {
  cleanName: string;
  platform: string | null;
  setCode: string | null;
  setName: string | null;
  cardNumber: string | null;
};

type CardTraderCandidate = {
  title: string;
  url: string;
  cardNumber: string | null;
  setName: string | null;
  rarity: string | null;
  score: number;
};

type CardTraderDetail = {
  title: string;
  url: string;
  price: number | null;
  priceBasis: string;
  currency: Currency | null;
  rawPriceText: string | null;
  extractedPrices: ExtractedPrice[];
  marketMetrics: CardTraderMarketMetrics;
};

type ExtractedPrice = {
  price: number;
  basis: string;
  currency: Currency | null;
  context: string;
};

type CardTraderMarketMetrics = {
  bestDeal: number | null;
  ctMinPrice: number | null;
  ctMarketPrice: number | null;
  usMarketPrice: number | null;
  currency: Currency | null;
};

type ScryfallSearchResponse = {
  data?: ScryfallCard[];
};

type ScryfallCard = {
  id?: string;
  name?: string;
  set?: string;
  set_name?: string;
  collector_number?: string;
  rarity?: string;
};

const BASE = "https://www.cardtrader.com";
const SCRYFALL_BASE = "https://api.scryfall.com";
const TIMEOUT = 15000;

const KNOWN_SET_ALIASES: Record<string, { name: string; total?: string }> = {
  POR: { name: "Perfect Order", total: "088" },
  SUDA: { name: "Supreme Darkness" },
  SOS: { name: "Secrets of Strixhaven", total: "276" }
};

const YUGIOH_FALLBACK_SETS = [
  "Supreme Darkness",
  "Alliance Insight",
  "Doom of Dimensions",
  "The Infinite Forbidden",
  "Legacy of Destruction",
  "Phantom Nightmare",
  "Age of Overlord",
  "Duelist Nexus"
];

const RARITY_SLUGS = [
  "mythic-rare",
  "common",
  "rare",
  "super-rare",
  "ultra-rare",
  "secret-rare",
  "quarter-century-secret-rare",
  "starlight-rare",
  "collectors-rare",
  "collector-rare",
  "ultimate-rare",
  "ghost-rare",
  "parallel-rare",
  "platinum-secret-rare",
  "gold-rare",
  "full-art",
  "special-illustration-rare",
  "illustration-rare",
  "double-rare",
  "triple-rare",
  "holo-rare",
  "uncommon"
];

const MAGIC_RARITY_SLUGS = ["mythic-rare", "rare", "uncommon", "common"];

const TRUSTED_PRICE_LABELS = [
  "Best Deal",
  "CT Min Price",
  "CT Market Price",
  "US Market Price"
];

export async function getCardTraderPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (item.category !== "tcg") return null;

  const query = String(item.name || "").trim();
  if (!query) return null;

  const parsed = parseTcgQuery(item);

  console.log("🟧 CT called:", {
    itemId: item.id,
    name: item.name,
    parsed
  });

  const scryfallCards =
    parsed.platform === "magic" ? await resolveFromScryfall(parsed) : [];

  const candidates = dedupeCandidates([
    ...buildMagicCandidates(parsed, scryfallCards),
    ...buildDirectCandidates(parsed),
    ...buildYugiohFallbackCandidates(parsed),
    ...(await searchCandidates(parsed))
  ]).sort((a, b) => b.score - a.score);

  console.log(
    "🟧 CT candidates:",
    candidates.slice(0, 30).map((candidate) => ({
      title: candidate.title,
      score: Number(candidate.score.toFixed(2)),
      url: candidate.url
    }))
  );

  let bestNoPrice:
    | {
        candidate: CardTraderCandidate;
        detail: CardTraderDetail;
        confidence: number;
      }
    | null = null;

  for (const candidate of candidates) {
    console.log("🟧 CT Detail:", candidate.url);

    const html = await fetchHtml(candidate.url);
    if (!html) continue;

    const detail = parseDetail(html, candidate.url);
    if (!detail) continue;

    if (!isDetailCompatible(parsed, candidate, detail)) {
      console.log("🟧 CT incompatible detail skipped:", {
        parsed,
        candidate,
        detailTitle: detail.title,
        url: detail.url
      });
      continue;
    }

    const confidence = computeConfidence(parsed, candidate, detail);
    const currency = detail.currency ?? detail.marketMetrics.currency ?? "EUR";

    console.log("🟧 CT parsed:", {
      title: detail.title,
      price: detail.price,
      priceBasis: detail.priceBasis,
      currency,
      marketMetrics: detail.marketMetrics,
      extractedPrices: detail.extractedPrices.slice(0, 8),
      confidence,
      url: detail.url
    });

    if (!detail.price || detail.price <= 0) {
      if (!bestNoPrice || confidence > bestNoPrice.confidence) {
        bestNoPrice = {
          candidate,
          detail: {
            ...detail,
            currency
          },
          confidence
        };
      }

      continue;
    }

    return {
      price: Number(detail.price.toFixed(2)),
      currency,
      source: "cardtrader",
      confidence,
      matchedTitle: detail.title,
      matchedUrl: detail.url,
      query,
      metadata: {
        provider: "cardtrader",
        hasPrice: true,
        priceBasis: detail.priceBasis,
        currency,
        originalCurrency: currency,

        bestDeal: detail.marketMetrics.bestDeal,
        ctMinPrice: detail.marketMetrics.ctMinPrice,
        ctMarketPrice: detail.marketMetrics.ctMarketPrice,
        usMarketPrice: detail.marketMetrics.usMarketPrice,
        marketMetrics: detail.marketMetrics,

        rawPriceText: detail.rawPriceText,
        extractedPrices: detail.extractedPrices,

        parsed,
        candidate,
        scryfallCandidates: scryfallCards.slice(0, 10)
      }
    };
  }

  if (bestNoPrice) {
    const currency =
      bestNoPrice.detail.currency ??
      bestNoPrice.detail.marketMetrics.currency ??
      "EUR";

    return {
      price: 0,
      currency,
      source: "cardtrader",
      confidence: bestNoPrice.confidence,
      matchedTitle: bestNoPrice.detail.title,
      matchedUrl: bestNoPrice.detail.url,
      query,
      metadata: {
        provider: "cardtrader",
        hasPrice: false,
        priceBasis: bestNoPrice.detail.priceBasis,
        currency,
        originalCurrency: currency,

        bestDeal: bestNoPrice.detail.marketMetrics.bestDeal,
        ctMinPrice: bestNoPrice.detail.marketMetrics.ctMinPrice,
        ctMarketPrice: bestNoPrice.detail.marketMetrics.ctMarketPrice,
        usMarketPrice: bestNoPrice.detail.marketMetrics.usMarketPrice,
        marketMetrics: bestNoPrice.detail.marketMetrics,

        rawPriceText: bestNoPrice.detail.rawPriceText,
        extractedPrices: bestNoPrice.detail.extractedPrices,

        parsed,
        candidate: bestNoPrice.candidate,
        scryfallCandidates: scryfallCards.slice(0, 10)
      }
    };
  }

  console.log("🟧 CT no usable page found:", parsed);
  return null;
}

function parseTcgQuery(item: Item): ParsedTcgQuery {
  const rawName = String(item.name || "").trim();
  const platform = normalizePlatform(item.platform);
  const region = String(item.region || "").trim();

  const parenthesisMatch = rawName.match(/\(([^)]+)\)/);
  const content = parenthesisMatch?.[1] ?? "";

  const parts = content
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const parenthesisSetCode =
    parts.find(
      (part) =>
        /^[A-Z0-9]{2,12}$/i.test(part) &&
        !/^\d+[a-zA-Z]?\/?\d*[a-zA-Z]?$/i.test(part) &&
        !isGenericPlatformToken(part)
    ) ?? null;

  const regionIsCardNumber = /^\d+[a-zA-Z]?\/?\d*[a-zA-Z]?$/i.test(region);

  const regionAsSetName =
    region && !regionIsCardNumber && !isGenericPlatformToken(region)
      ? region
      : null;

  const knownSetFromParenthesis =
    parenthesisSetCode && KNOWN_SET_ALIASES[normalizeSetCode(parenthesisSetCode)]
      ? KNOWN_SET_ALIASES[normalizeSetCode(parenthesisSetCode)].name
      : null;

  const cardNumber =
    parts.find((part) => /^\d+[a-zA-Z]?\/?\d*[a-zA-Z]?$/.test(part)) ||
    (regionIsCardNumber ? region : null) ||
    rawName.match(/\b(\d+[a-zA-Z]?\/?\d*[a-zA-Z]?)\b/)?.[1] ||
    null;

  const cleanName = rawName
    .replace(/\([^)]*\)/g, "")
    .replace(/\b\d+[a-zA-Z]?\/?\d*[a-zA-Z]?\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    cleanName: cleanName || rawName,
    platform,
    setCode: parenthesisSetCode ? normalizeSetCode(parenthesisSetCode) : null,
    setName: regionAsSetName || knownSetFromParenthesis || null,
    cardNumber: cardNumber ? normalizeCardNumber(cardNumber) : null
  };
}

async function resolveFromScryfall(
  parsed: ParsedTcgQuery
): Promise<ScryfallCard[]> {
  const queries = buildScryfallQueries(parsed);
  const cards: ScryfallCard[] = [];
  const seen = new Set<string>();

  for (const query of queries) {
    const url = `${SCRYFALL_BASE}/cards/search?q=${encodeURIComponent(
      query
    )}&unique=prints&order=released`;

    console.log("🟧 CT resolving Magic identity from Scryfall:", {
      query,
      url
    });

    const response = await fetchJson<ScryfallSearchResponse>(url);

    for (const card of response?.data ?? []) {
      if (!card.id || seen.has(card.id)) continue;

      seen.add(card.id);
      cards.push(card);
    }

    if (cards.length > 0 && (parsed.cardNumber || parsed.setCode)) break;
  }

  return cards.slice(0, 15);
}

function buildScryfallQueries(parsed: ParsedTcgQuery): string[] {
  const name = escapeScryfallValue(parsed.cleanName);
  const queries: string[] = [];

  if (parsed.cardNumber && parsed.setCode) {
    queries.push(
      `!"${name}" set:${parsed.setCode.toLowerCase()} cn:${parsed.cardNumber}`
    );
  }

  if (parsed.setCode) {
    queries.push(`!"${name}" set:${parsed.setCode.toLowerCase()}`);
  }

  if (parsed.cardNumber) {
    queries.push(`!"${name}" cn:${parsed.cardNumber}`);
  }

  queries.push(`!"${name}"`);
  queries.push(name);

  return [...new Set(queries)];
}

function buildMagicCandidates(
  parsed: ParsedTcgQuery,
  scryfallCards: ScryfallCard[]
): CardTraderCandidate[] {
  if (parsed.platform !== "magic") return [];

  const candidates: CardTraderCandidate[] = [];

  const baseCards =
    scryfallCards.length > 0
      ? scryfallCards
      : [
          {
            name: parsed.cleanName,
            set: parsed.setCode ?? undefined,
            set_name:
              parsed.setName ??
              (parsed.setCode && KNOWN_SET_ALIASES[parsed.setCode]
                ? KNOWN_SET_ALIASES[parsed.setCode].name
                : undefined),
            collector_number: parsed.cardNumber ?? undefined,
            rarity: undefined
          }
        ];

  for (const card of baseCards) {
    const name = card.name || parsed.cleanName;
    const cardNumber = normalizeCardNumber(
      card.collector_number || parsed.cardNumber || ""
    );
    const setName =
      card.set_name ||
      parsed.setName ||
      (card.set && KNOWN_SET_ALIASES[normalizeSetCode(card.set)]
        ? KNOWN_SET_ALIASES[normalizeSetCode(card.set)].name
        : null);

    if (!name || !setName) continue;

    const setCode = normalizeSetCode(card.set || parsed.setCode || "");
    const total = (setCode && KNOWN_SET_ALIASES[setCode]?.total) || null;

    const nameSlug = slugify(name);
    const setSlug = slugify(setName);
    const raritySlugs = buildMagicRaritySlugs(card.rarity);

    for (const rarity of raritySlugs) {
      for (const numberPart of buildNumberVariants(cardNumber, total)) {
        const url = numberPart
          ? `${BASE}/en/cards/${nameSlug}-${rarity}-${numberPart}-${setSlug}`
          : `${BASE}/en/cards/${nameSlug}-${rarity}-${setSlug}`;

        candidates.push({
          title: `${name}${
            cardNumber ? ` (${cardNumber}${total ? `/${total}` : ""})` : ""
          } - ${setName}`,
          url,
          cardNumber: cardNumber || null,
          setName,
          rarity,
          score:
            scoreCandidate(parsed, {
              title: name,
              cardNumber: cardNumber || null,
              setName
            }) + 0.4
        });
      }
    }
  }

  return candidates.slice(0, 60);
}

function buildDirectCandidates(parsed: ParsedTcgQuery): CardTraderCandidate[] {
  const candidates: CardTraderCandidate[] = [];

  const nameSlug = slugify(parsed.cleanName);
  const setName =
    parsed.setName ||
    (parsed.setCode && KNOWN_SET_ALIASES[parsed.setCode]
      ? KNOWN_SET_ALIASES[parsed.setCode].name
      : null);

  const setSlug = setName ? slugify(setName) : null;
  const total =
    parsed.setCode && KNOWN_SET_ALIASES[parsed.setCode]?.total
      ? KNOWN_SET_ALIASES[parsed.setCode].total ?? null
      : null;

  const rarities =
    parsed.platform === "magic" ? MAGIC_RARITY_SLUGS : RARITY_SLUGS;

  if (setSlug) {
    for (const rarity of rarities) {
      for (const numberPart of buildNumberVariants(parsed.cardNumber, total)) {
        candidates.push({
          title: `${parsed.cleanName} - ${rarity} - ${setName}`,
          url: numberPart
            ? `${BASE}/en/cards/${nameSlug}-${rarity}-${numberPart}-${setSlug}`
            : `${BASE}/en/cards/${nameSlug}-${rarity}-${setSlug}`,
          cardNumber: parsed.cardNumber,
          setName,
          rarity,
          score: 0.7
        });
      }
    }
  }

  candidates.push({
    title: parsed.cleanName,
    url: `${BASE}/en/cards/${nameSlug}`,
    cardNumber: parsed.cardNumber,
    setName,
    rarity: null,
    score: 0.4
  });

  return candidates;
}

function buildYugiohFallbackCandidates(
  parsed: ParsedTcgQuery
): CardTraderCandidate[] {
  if (parsed.platform !== "yugioh") return [];

  const nameSlug = slugify(parsed.cleanName);
  const setNames = [
    parsed.setName,
    parsed.setCode && KNOWN_SET_ALIASES[parsed.setCode]
      ? KNOWN_SET_ALIASES[parsed.setCode].name
      : null,
    ...YUGIOH_FALLBACK_SETS
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  const uniqueSetNames = [...new Set(setNames)];
  const candidates: CardTraderCandidate[] = [];

  for (const setName of uniqueSetNames) {
    const setSlug = slugify(setName);

    for (const rarity of RARITY_SLUGS) {
      candidates.push({
        title: `${parsed.cleanName} - ${rarity} - ${setName}`,
        url: `${BASE}/en/cards/${nameSlug}-${rarity}-${setSlug}`,
        cardNumber: parsed.cardNumber,
        setName,
        rarity,
        score:
          scoreCandidate(parsed, {
            title: parsed.cleanName,
            cardNumber: parsed.cardNumber,
            setName
          }) + 0.25
      });
    }
  }

  return candidates.slice(0, 60);
}

async function searchCandidates(
  parsed: ParsedTcgQuery
): Promise<CardTraderCandidate[]> {
  const query = encodeURIComponent(
    [parsed.cleanName, parsed.cardNumber, parsed.setName, parsed.setCode]
      .filter(Boolean)
      .join(" ")
  );

  const urls = [
    `${BASE}/en/search?query=${query}`,
    `${BASE}/en/search?search=${query}`
  ];

  const results: CardTraderCandidate[] = [];

  for (const url of urls) {
    const html = await fetchHtml(url);
    if (!html) continue;

    const $ = cheerio.load(html);

    $("a[href]").each((_, el) => {
      const href = decodeHtml($(el).attr("href") || "");
      const absoluteUrl = absolutize(href);

      if (!absoluteUrl.includes("/en/cards/")) return;

      const title =
        cleanTitle($(el).text()) ||
        cleanTitle($(el).attr("title") || "") ||
        titleFromUrl(absoluteUrl);

      const score = scoreSearchCandidate(parsed, title, absoluteUrl);

      if (score < 0.45) return;

      results.push({
        title,
        url: absoluteUrl,
        cardNumber: extractCardNumberFromText(`${title} ${absoluteUrl}`),
        setName: extractSetNameFromTitle(title),
        rarity: extractRarityFromUrl(absoluteUrl),
        score
      });
    });

    if (results.length > 0) break;
  }

  return results.slice(0, 20);
}

function parseDetail(html: string, url: string): CardTraderDetail | null {
  const $ = cheerio.load(html);
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  const title =
    cleanTitle($("h1").first().text()) ||
    cleanTitle($("h2").first().text()) ||
    cleanTitle($("meta[property='og:title']").attr("content") || "") ||
    titleFromUrl(url);

  if (!title) return null;

  const extractedPrices = extractAllTrustedPrices($, html, bodyText);
  const marketMetrics = extractMarketMetrics(bodyText, extractedPrices);
  const selected = selectBestPrice(extractedPrices, marketMetrics);
  const rawPriceText = extractRawTrustedPriceText(bodyText);

  return {
    title,
    url,
    price: selected?.price ?? null,
    priceBasis: selected?.basis ?? "none",
    currency: selected?.currency ?? marketMetrics.currency ?? null,
    rawPriceText,
    extractedPrices,
    marketMetrics
  };
}

function extractMarketMetrics(
  bodyText: string,
  extractedPrices: ExtractedPrice[]
): CardTraderMarketMetrics {
  const bestDeal = extractMetricByLabel(bodyText, "Best Deal");
  const ctMinPrice = extractMetricByLabel(bodyText, "CT Min Price");
  const ctMarketPrice = extractMetricByLabel(bodyText, "CT Market Price");
  const usMarketPrice = extractMetricByLabel(bodyText, "US Market Price");

  const currency =
    bestDeal?.currency ??
    ctMinPrice?.currency ??
    ctMarketPrice?.currency ??
    usMarketPrice?.currency ??
    extractedPrices.find((price) => price.currency)?.currency ??
    null;

  return {
    bestDeal: bestDeal?.price ?? null,
    ctMinPrice: ctMinPrice?.price ?? null,
    ctMarketPrice: ctMarketPrice?.price ?? null,
    usMarketPrice: usMarketPrice?.price ?? null,
    currency
  };
}

function extractMetricByLabel(
  text: string,
  label: string
): { price: number; currency: Currency | null } | null {
  const segment = extractSegmentAfterLabel(text, label, 100);
  if (!segment) return null;

  return extractFirstPriceFromSegment(segment);
}

function extractAllTrustedPrices(
  $: cheerio.CheerioAPI,
  html: string,
  bodyText: string
): ExtractedPrice[] {
  const prices: ExtractedPrice[] = [];

  for (const label of TRUSTED_PRICE_LABELS) {
    const segment = extractSegmentAfterLabel(bodyText, label, 180);
    const parsed = segment ? extractFirstPriceFromSegment(segment) : null;

    if (parsed) {
      prices.push({
        price: parsed.price,
        currency: parsed.currency,
        basis: `text.${label}`,
        context: segment ?? ""
      });
    }
  }

  $("body *").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();

    if (!text || text.length > 400) return;

    const hasTrustedLabel = TRUSTED_PRICE_LABELS.some((label) =>
      normalizeText(text).includes(normalizeText(label))
    );

    if (!hasTrustedLabel) return;

    const parsed = extractFirstPriceFromSegment(text);
    if (!parsed) return;

    prices.push({
      price: parsed.price,
      currency: parsed.currency,
      basis: "dom.trusted_label",
      context: text
    });
  });

  prices.push(...extractPricesFromJsonLd(html));
  prices.push(...extractLooseScriptPrices(html));

  return dedupePrices(prices).filter((entry) => isUsableCardPrice(entry.price));
}

function extractPricesFromJsonLd(html: string): ExtractedPrice[] {
  const $ = cheerio.load(html);
  const prices: ExtractedPrice[] = [];

  $("script[type='application/ld+json']").each((_, el) => {
    const raw = $(el).html() || "";
    const parsed = safeJsonParse(raw);

    if (!parsed) return;

    walkJson(parsed, [], prices);
  });

  return prices;
}

function walkJson(
  value: unknown,
  path: string[],
  prices: ExtractedPrice[],
  parent?: Record<string, unknown>
) {
  if (value == null) return;

  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      walkJson(entry, [...path, String(index)], prices, parent)
    );
    return;
  }

  if (typeof value !== "object") return;

  const record = value as Record<string, unknown>;

  for (const [key, nestedValue] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase();

    if (
      [
        "price",
        "amount",
        "bestdeal",
        "best_deal",
        "ctminprice",
        "ct_min_price",
        "ctmarketprice",
        "ct_market_price",
        "marketprice",
        "market_price",
        "minprice",
        "min_price"
      ].includes(normalizedKey)
    ) {
      const price = parseJsonPriceValue(nestedValue);

      if (price && isUsableCardPrice(price)) {
        let basis = `json.${[...path, key].join(".")}`;

        if (record["@type"] === "Offer" || parent?.["@type"] === "Offer") {
          basis = "cardtrader.offer.price";
        }

        prices.push({
          price,
          currency:
            inferCurrencyFromObject(record) ||
            inferCurrencyFromObject(parent || {}),
          basis,
          context: JSON.stringify(record).slice(0, 500)
        });
      }
    }

    walkJson(nestedValue, [...path, key], prices, record);
  }
}

function extractLooseScriptPrices(html: string): ExtractedPrice[] {
  const prices: ExtractedPrice[] = [];
  const patterns = [
    /"(?:(?:ct_)?market_price|marketPrice|ctMarketPrice|bestDeal|best_deal|minPrice|min_price|price)"\s*:\s*"?([€$£]?\s*\d{1,6}(?:[.,]\d{1,2})?)"?/gi,
    /(?:ctMarketPrice|ctMinPrice|bestDeal|marketPrice|minPrice|price)\s*[:=]\s*"?([€$£]?\s*\d{1,6}(?:[.,]\d{1,2})?)"?/gi
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const raw = match[1];
      const price = parseCardPrice(raw);
      const currency = parseCurrency(raw?.match(/[€$£]/)?.[0]);

      if (!price || !isUsableCardPrice(price)) continue;

      prices.push({
        price,
        currency,
        basis: "script.loose_price",
        context: getMatchContext(html, match.index ?? 0, 180)
      });
    }
  }

  return prices;
}

function selectBestPrice(
  prices: ExtractedPrice[],
  marketMetrics: CardTraderMarketMetrics
): ExtractedPrice | null {
  if (marketMetrics.bestDeal && marketMetrics.bestDeal > 0) {
    return {
      price: marketMetrics.bestDeal,
      currency: marketMetrics.currency,
      basis: "text.Best Deal",
      context: "CardTrader Best Deal"
    };
  }

  const trusted = prices
    .filter((entry) => isUsableCardPrice(entry.price))
    .filter((entry) => !isBadPriceContext(entry.context))
    .sort((a, b) => getPriceBasisPriority(b.basis) - getPriceBasisPriority(a.basis));

  return trusted[0] ?? null;
}

function computeConfidence(
  parsed: ParsedTcgQuery,
  candidate: CardTraderCandidate,
  detail: CardTraderDetail
): number {
  let confidence = 0.45;

  confidence += Math.min(0.2, candidate.score * 0.08);

  if (detail.price && detail.price > 0) confidence += 0.18;

  if (
    parsed.cardNumber &&
    candidate.cardNumber &&
    normalizeCardNumber(candidate.cardNumber) === parsed.cardNumber
  ) {
    confidence += 0.15;
  }

  if (
    parsed.setName &&
    candidate.setName &&
    normalizeText(candidate.setName).includes(normalizeText(parsed.setName))
  ) {
    confidence += 0.08;
  }

  if (detail.priceBasis === "text.Best Deal") confidence += 0.08;
  if (detail.priceBasis === "cardtrader.offer.price") confidence += 0.06;
  if (detail.currency === "USD" || detail.currency === "EUR") confidence += 0.04;

  return Math.max(0.45, Math.min(0.92, Number(confidence.toFixed(2))));
}

function isDetailCompatible(
  parsed: ParsedTcgQuery,
  candidate: CardTraderCandidate,
  detail: CardTraderDetail
): boolean {
  const normalizedTitle = normalizeText(detail.title);
  const normalizedName = normalizeText(parsed.cleanName);

  const wantedTokens = normalizedName
    .split(" ")
    .filter((token) => token.length > 2);

  const matchedTokens = wantedTokens.filter((token) =>
    normalizedTitle.includes(token)
  );

  if (
    wantedTokens.length > 0 &&
    matchedTokens.length / wantedTokens.length < 0.7
  ) {
    return false;
  }

  if (
    parsed.cardNumber &&
    candidate.cardNumber &&
    normalizeCardNumber(candidate.cardNumber) !== parsed.cardNumber
  ) {
    return false;
  }

  return true;
}

function scoreCandidate(
  parsed: ParsedTcgQuery,
  candidate: {
    title: string;
    cardNumber: string | null;
    setName: string | null;
  }
): number {
  let score = 0;

  const wanted = normalizeText(parsed.cleanName);
  const title = normalizeText(candidate.title);

  score += similarityScore(wanted, title);

  if (title === wanted) score += 1;
  if (title.includes(wanted)) score += 0.4;

  if (
    parsed.cardNumber &&
    candidate.cardNumber &&
    normalizeCardNumber(candidate.cardNumber) === parsed.cardNumber
  ) {
    score += 0.8;
  }

  if (
    parsed.setName &&
    candidate.setName &&
    normalizeText(candidate.setName).includes(normalizeText(parsed.setName))
  ) {
    score += 0.5;
  }

  return score;
}

function scoreSearchCandidate(
  parsed: ParsedTcgQuery,
  title: string,
  url: string
): number {
  let score = 0;

  const wanted = normalizeText(parsed.cleanName);
  const normalizedTitle = normalizeText(title);
  const normalizedUrl = normalizeText(url).replace(/\s+/g, "-");

  score += similarityScore(wanted, normalizedTitle);

  if (normalizedTitle.includes(wanted)) score += 0.7;
  if (normalizedUrl.includes(wanted.replace(/\s+/g, "-"))) score += 0.6;

  const tokens = wanted.split(" ").filter((token) => token.length > 2);
  const matched = tokens.filter(
    (token) => normalizedTitle.includes(token) || normalizedUrl.includes(token)
  );

  if (tokens.length > 0) score += (matched.length / tokens.length) * 0.8;

  return Number(score.toFixed(4));
}

function buildMagicRaritySlugs(rarity?: string): string[] {
  const slugs = new Set<string>();
  const normalized = normalizeText(rarity || "");

  if (normalized.includes("mythic")) slugs.add("mythic-rare");
  if (normalized.includes("rare")) slugs.add("rare");
  if (normalized.includes("uncommon")) slugs.add("uncommon");
  if (normalized.includes("common")) slugs.add("common");

  MAGIC_RARITY_SLUGS.forEach((slug) => slugs.add(slug));

  return [...slugs];
}

function buildNumberVariants(
  cardNumber: string | null,
  total: string | null
): string[] {
  if (!cardNumber) return [""];

  const variants = new Set<string>();

  if (total) variants.add(`${cardNumber}-${total}`);
  variants.add(cardNumber);

  return [...variants];
}

function getPriceBasisPriority(basis: string): number {
  const normalized = basis.toLowerCase();

  if (normalized.includes("best deal")) return 100;
  if (normalized.includes("ct min price")) return 95;
  if (normalized.includes("ct market price")) return 90;
  if (normalized.includes("cardtrader.offer.price")) return 88;
  if (normalized.includes("marketprice")) return 85;
  if (normalized.includes("market_price")) return 85;
  if (normalized.includes("minprice")) return 80;
  if (normalized.includes("min_price")) return 80;
  if (normalized.includes("json")) return 70;
  if (normalized.includes("dom")) return 60;
  if (normalized.includes("script")) return 50;

  return 10;
}

function extractFirstPriceFromSegment(
  segment: string
): { price: number; currency: Currency | null } | null {
  const leading = segment.match(/([€$£])\s*(\d{1,6}(?:[.,]\d{1,2})?)/);

  if (leading) {
    const price = parseCardPrice(leading[2]);
    const currency = parseCurrency(leading[1]);

    if (price && price > 0) return { price, currency };
  }

  const trailing = segment.match(/(\d{1,6}(?:[.,]\d{1,2})?)\s*([€$£])/);

  if (trailing) {
    const price = parseCardPrice(trailing[1]);
    const currency = parseCurrency(trailing[2]);

    if (price && price > 0) return { price, currency };
  }

  return null;
}

function parseCardPrice(value: string | null | undefined): number | null {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const euro = parseEuroPrice(raw);
  if (euro && euro > 0) return euro;

  const cleaned = raw
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");

  const parsed = Number(cleaned);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseJsonPriceValue(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    if (value > 10000) return Number((value / 100).toFixed(2));
    return value;
  }

  if (typeof value === "string") return parseCardPrice(value);

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;

    return parseJsonPriceValue(
      record.amount ??
        record.value ??
        record.price ??
        record.cents ??
        record.amountCents ??
        record.amount_cents
    );
  }

  return null;
}

function inferCurrencyFromObject(
  record: Record<string, unknown>
): Currency | null {
  const raw =
    record.priceCurrency ??
    record.currency ??
    record.currencyCode ??
    record.currency_code ??
    record.symbol ??
    null;

  const value = String(raw || "").trim().toUpperCase();

  if (value === "EUR" || value === "€") return "EUR";
  if (value === "USD" || value === "$") return "USD";
  if (value === "GBP" || value === "£") return "GBP";

  return null;
}

function parseCurrency(value?: string): Currency | null {
  if (value === "€") return "EUR";
  if (value === "$") return "USD";
  if (value === "£") return "GBP";
  return null;
}

function extractSegmentAfterLabel(
  text: string,
  label: string,
  size: number
): string | null {
  const index = text.toLowerCase().indexOf(label.toLowerCase());
  if (index === -1) return null;

  return text.slice(index, index + size).trim();
}

function extractRawTrustedPriceText(text: string): string | null {
  for (const label of TRUSTED_PRICE_LABELS) {
    const segment = extractSegmentAfterLabel(text, label, 180);
    if (segment) return segment;
  }

  return null;
}

function isUsableCardPrice(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value < 50000;
}

function isBadPriceContext(value: string): boolean {
  const normalized = normalizeText(value);

  return [
    "shipping",
    "shipment",
    "delivery",
    "password",
    "login",
    "email",
    "signup",
    "sign up",
    "wallet",
    "credit",
    "balance"
  ].some((token) => normalized.includes(token));
}

function dedupePrices(prices: ExtractedPrice[]): ExtractedPrice[] {
  const seen = new Set<string>();

  return prices.filter((price) => {
    const key = `${price.price}|${price.currency}|${price.basis}`;
    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

function dedupeCandidates(
  list: CardTraderCandidate[]
): CardTraderCandidate[] {
  const seen = new Set<string>();

  return list.filter((candidate) => {
    if (!candidate.url || seen.has(candidate.url)) return false;

    seen.add(candidate.url);
    return true;
  });
}

function extractCardNumberFromText(value: string): string | null {
  const match =
    value.match(/#\s*([A-Za-z0-9]+)\b/) ||
    value.match(/\b(\d{1,4})\/\d{1,4}\b/) ||
    value.match(/\b([A-Z]{1,5}\d{1,4})\b/i);

  return match?.[1] ? normalizeCardNumber(match[1]) : null;
}

function extractSetNameFromTitle(title: string): string | null {
  const parts = title.split("-").map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : null;
}

function extractRarityFromUrl(url: string): string | null {
  const normalized = normalizeText(url).replace(/\s+/g, "-");
  return RARITY_SLUGS.find((slug) => normalized.includes(slug)) ?? null;
}

function getMatchContext(text: string, index: number, size: number): string {
  return text.slice(Math.max(0, index - size), index + size);
}

function normalizePlatform(value: string | null): string | null {
  const normalized = normalizeText(String(value || ""))
    .replace(/[^a-z0-9]/g, "")
    .trim();

  if (!normalized) return null;

  if (normalized === "pokemon" || normalized === "pokemontcg") return "pokemon";
  if (
    normalized === "yugioh" ||
    normalized === "yugiohtcg" ||
    normalized === "yugi"
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

function isGenericPlatformToken(value: string): boolean {
  const normalized = normalizePlatform(value);

  return [
    "pokemon",
    "yugioh",
    "magic",
    "onepiece",
    "lorcana",
    "digimon",
    "fleshandblood"
  ].includes(normalized || "");
}

function normalizeSetCode(value: string): string {
  return String(value || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .trim();
}

function normalizeCardNumber(value: string | null): string {
  return String(value || "")
    .split("/")[0]
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .trim();
}

function slugify(value: string): string {
  return normalizeText(value)
    .replace(/\bpokemon\b/g, "")
    .replace(/\bpokémon\b/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cleanTitle(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() || "";

    return last.replace(/-/g, " ").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function absolutize(href: string): string {
  if (!href) return "";
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `${BASE}${href}`;
  return `${BASE}/${href}`;
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function escapeScryfallValue(value: string): string {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .trim();
}

async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
        Referer: BASE
      }
    });

    if (!res.ok) {
      console.log("❌ CT fetch failed:", {
        status: res.status,
        url
      });

      return null;
    }

    return await res.text();
  } catch (error) {
    console.log("❌ CT fetch error:", {
      url,
      error
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json"
      }
    });

    if (!res.ok) {
      console.log("❌ CT identity fetch failed:", {
        status: res.status,
        url
      });

      return null;
    }

    return (await res.json()) as T;
  } catch (error) {
    console.log("❌ CT identity fetch error:", {
      url,
      error
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}