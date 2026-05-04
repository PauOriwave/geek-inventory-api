import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import { ScraperSourceResult } from "../scraper.types";
import { normalizeText, parseEuroPrice, similarityScore } from "../utils";

type ParsedTcgQuery = {
  cleanName: string;
  setCode: string | null;
  cardNumber: string | null;
};

type TcgDexCard = {
  id?: string;
  name?: string;
  localId?: string;
  rarity?: string;
  image?: string;
  set?: {
    id?: string;
    name?: string;
    cardCount?: {
      official?: number;
      total?: number;
    };
  };
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
  currency: "EUR" | "USD" | "GBP" | null;
  rawPriceText: string | null;
  extractedPrices: ExtractedPrice[];
};

type ExtractedPrice = {
  price: number;
  basis: string;
  currency: "EUR" | "USD" | "GBP" | null;
  context: string;
};

const CARDTRADER_BASE_URL = "https://www.cardtrader.com";
const TCGDEX_BASE_URL = "https://api.tcgdex.net/v2/en";
const REQUEST_TIMEOUT_MS = 15000;

const KNOWN_SET_ALIASES: Record<string, { name: string; total?: string }> = {
  POR: {
    name: "Perfect Order",
    total: "088"
  }
};

const RARITY_SLUGS = [
  "full-art",
  "ultra-rare",
  "special-illustration-rare",
  "illustration-rare",
  "secret-rare",
  "double-rare",
  "triple-rare",
  "rare",
  "holo-rare",
  "super-rare",
  "common",
  "uncommon"
];

const TRUSTED_PRICE_LABELS = [
  "Best Deal",
  "CT Min Price",
  "CT Market Price",
  "US Market Price"
];

const TRUSTED_JSON_PRICE_KEYS = [
  "bestDeal",
  "best_deal",
  "ctMinPrice",
  "ct_min_price",
  "ctMarketPrice",
  "ct_market_price",
  "marketPrice",
  "market_price",
  "minPrice",
  "min_price",
  "priceCents",
  "price_cents",
  "price",
  "amount"
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

  const tcgdexCards = await resolveFromTcgDex(parsed);
  const candidates = buildCardTraderCandidates(parsed, tcgdexCards);

  console.log(
    "🟧 CT candidates:",
    candidates.slice(0, 12).map((candidate) => ({
      title: candidate.title,
      cardNumber: candidate.cardNumber,
      setName: candidate.setName,
      rarity: candidate.rarity,
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

    const detail = parseCardTraderDetail(html, candidate.url);

    if (!detail) continue;

    const confidence = computeConfidence(parsed, candidate, detail);

    console.log("🟧 CT parsed:", {
      title: detail.title,
      price: detail.price,
      priceBasis: detail.priceBasis,
      currency: detail.currency,
      rawPriceText: detail.rawPriceText,
      extractedPrices: detail.extractedPrices.slice(0, 8),
      confidence,
      url: detail.url
    });

    if (!isDetailCompatible(parsed, candidate, detail)) {
      console.log("🟧 CT incompatible detail skipped:", {
        parsed,
        candidate,
        detailTitle: detail.title,
        url: detail.url
      });

      continue;
    }

    if (!detail.price || detail.price <= 0) {
      if (!bestNoPrice || confidence > bestNoPrice.confidence) {
        bestNoPrice = {
          candidate,
          detail,
          confidence
        };
      }

      continue;
    }

    return {
      price: Number(detail.price.toFixed(2)),
      source: "cardtrader",
      confidence,
      matchedTitle: detail.title,
      matchedUrl: detail.url,
      query,
      metadata: {
        provider: "cardtrader",
        hasPrice: true,
        priceBasis: detail.priceBasis,
        currency: detail.currency,
        rawPriceText: detail.rawPriceText,
        extractedPrices: detail.extractedPrices,
        parsed,
        candidate,
        tcgdexCandidates: tcgdexCards.slice(0, 10)
      }
    };
  }

  if (bestNoPrice) {
    return {
      price: 0,
      source: "cardtrader",
      confidence: bestNoPrice.confidence,
      matchedTitle: bestNoPrice.detail.title,
      matchedUrl: bestNoPrice.detail.url,
      query,
      metadata: {
        provider: "cardtrader",
        hasPrice: false,
        priceBasis: bestNoPrice.detail.priceBasis,
        currency: bestNoPrice.detail.currency,
        rawPriceText: bestNoPrice.detail.rawPriceText,
        extractedPrices: bestNoPrice.detail.extractedPrices,
        parsed,
        candidate: bestNoPrice.candidate,
        tcgdexCandidates: tcgdexCards.slice(0, 10)
      }
    };
  }

  console.log("🟧 CT no usable page found:", parsed);

  return null;
}

async function resolveFromTcgDex(
  parsed: ParsedTcgQuery
): Promise<TcgDexCard[]> {
  const url = `${TCGDEX_BASE_URL}/cards?name=${encodeURIComponent(
    parsed.cleanName
  )}`;

  console.log("🟧 CT resolving identity from TCGdex:", url);

  const cards = await fetchJson<TcgDexCard[]>(url);

  if (!cards || cards.length === 0) return [];

  return cards
    .map((card) => ({
      ...card,
      score: scoreTcgDexCard(parsed, card)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}

function buildCardTraderCandidates(
  parsed: ParsedTcgQuery,
  tcgdexCards: TcgDexCard[]
): CardTraderCandidate[] {
  const candidates: CardTraderCandidate[] = [];
  const seen = new Set<string>();

  const knownSet = parsed.setCode ? KNOWN_SET_ALIASES[parsed.setCode] : null;

  const baseCards =
    tcgdexCards.length > 0
      ? tcgdexCards
      : [
          {
            name: parsed.cleanName,
            localId: parsed.cardNumber ?? undefined,
            set: knownSet
              ? {
                  name: knownSet.name,
                  cardCount: {
                    official: knownSet.total
                      ? Number(knownSet.total)
                      : undefined
                  }
                }
              : undefined
          }
        ];

  for (const card of baseCards) {
    const name = card.name || parsed.cleanName;
    const localId = normalizeCardNumber(card.localId || parsed.cardNumber || "");
    const setName = card.set?.name || knownSet?.name || null;

    if (!name || !localId || !setName) continue;

    const total =
      padCardTotal(card.set?.cardCount?.official) ||
      padCardTotal(card.set?.cardCount?.total) ||
      knownSet?.total ||
      null;

    const setSlug = slugify(setName);
    const nameSlug = slugify(name);
    const raritySlugs = buildRaritySlugs(card.rarity);

    for (const raritySlug of raritySlugs) {
      const numberPart = total ? `${localId}-${total}` : localId;

      const url = `${CARDTRADER_BASE_URL}/en/cards/${nameSlug}-${raritySlug}-${numberPart}-${setSlug}`;

      addCandidate(candidates, seen, {
        title: `${name} (${localId}${total ? `/${total}` : ""}) - ${setName}`,
        url,
        cardNumber: localId,
        setName,
        rarity: raritySlug,
        score: scoreCandidate(parsed, {
          title: name,
          cardNumber: localId,
          setName
        })
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

function buildRaritySlugs(rarity?: string): string[] {
  const slugs = new Set<string>();
  const normalized = normalizeText(rarity || "");

  if (normalized.includes("special") && normalized.includes("illustration")) {
    slugs.add("special-illustration-rare");
  }

  if (normalized.includes("illustration")) {
    slugs.add("illustration-rare");
  }

  if (normalized.includes("ultra")) {
    slugs.add("ultra-rare");
  }

  if (normalized.includes("double")) {
    slugs.add("double-rare");
  }

  if (normalized.includes("rare")) {
    slugs.add("rare");
  }

  for (const slug of RARITY_SLUGS) {
    slugs.add(slug);
  }

  return [...slugs];
}

function parseCardTraderDetail(
  html: string,
  url: string
): CardTraderDetail | null {
  const $ = cheerio.load(html);

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  const title =
    cleanTitle($("h1").first().text()) ||
    cleanTitle($("h2").first().text()) ||
    cleanTitle($("meta[property='og:title']").attr("content") || "") ||
    titleFromUrl(url);

  if (!title) return null;

  const extractedPrices = extractAllTrustedPrices($, html, bodyText);
  const selected = selectBestExtractedPrice(extractedPrices);
  const rawPriceText = extractRawTrustedPriceText(bodyText);

  return {
    title,
    url,
    price: selected?.price ?? null,
    priceBasis: selected?.basis ?? "none",
    currency: selected?.currency ?? null,
    rawPriceText,
    extractedPrices
  };
}

function extractAllTrustedPrices(
  $: cheerio.CheerioAPI,
  html: string,
  bodyText: string
): ExtractedPrice[] {
  const prices: ExtractedPrice[] = [];

  prices.push(...extractTrustedPricesFromText(bodyText));
  prices.push(...extractTrustedPricesFromDom($));
  prices.push(...extractTrustedPricesFromScripts(html));

  return dedupePrices(prices).filter((entry) => isUsableCardPrice(entry.price));
}

function extractTrustedPricesFromText(text: string): ExtractedPrice[] {
  const prices: ExtractedPrice[] = [];

  for (const label of TRUSTED_PRICE_LABELS) {
    const segment = extractSegmentAfterLabel(text, label, 180);

    if (!segment) continue;

    const parsed = extractFirstPriceFromSegment(segment);

    if (!parsed) continue;

    prices.push({
      price: parsed.price,
      currency: parsed.currency,
      basis: `text.${label}`,
      context: segment
    });
  }

  return prices;
}

function extractTrustedPricesFromDom($: cheerio.CheerioAPI): ExtractedPrice[] {
  const prices: ExtractedPrice[] = [];

  $("body *").each((_, el) => {
    const node = $(el);
    const text = node.text().replace(/\s+/g, " ").trim();

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

  return prices;
}

function extractTrustedPricesFromScripts(html: string): ExtractedPrice[] {
  const prices: ExtractedPrice[] = [];
  const $ = cheerio.load(html);

  $("script").each((_, el) => {
    const content = $(el).html() || "";

    if (!content) return;

    const jsonBlocks = extractJsonBlocks(content);

    for (const block of jsonBlocks) {
      const parsed = safeJsonParse(block);
      if (!parsed) continue;

      prices.push(...extractPricesFromJson(parsed));
    }

    prices.push(...extractLooseScriptPrices(content));
  });

  return prices;
}

function extractJsonBlocks(scriptContent: string): string[] {
  const blocks: string[] = [];

  const trimmed = scriptContent.trim();

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    blocks.push(trimmed);
  }

  const nextDataMatch = trimmed.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>(.*?)<\/script>/is
  );

  if (nextDataMatch?.[1]) {
    blocks.push(nextDataMatch[1]);
  }

  const assignmentMatches = [
    ...trimmed.matchAll(
      /(?:window\.__INITIAL_STATE__|window\.__NUXT__|window\.__APOLLO_STATE__|window\.__REDUX_STATE__)\s*=\s*({.*?});/gis
    )
  ];

  for (const match of assignmentMatches) {
    if (match[1]) blocks.push(match[1]);
  }

  return blocks;
}

function extractPricesFromJson(value: unknown): ExtractedPrice[] {
  const prices: ExtractedPrice[] = [];

  function walk(node: unknown, path: string[]) {
    if (node == null) return;

    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, [...path, String(index)]));
      return;
    }

    if (typeof node === "object") {
      const record = node as Record<string, unknown>;

      for (const [key, nestedValue] of Object.entries(record)) {
        const normalizedKey = key.toLowerCase();

        if (isTrustedJsonPriceKey(normalizedKey)) {
          const parsed = parseJsonPriceValue(nestedValue);

          if (parsed && isUsableCardPrice(parsed)) {
            prices.push({
              price: parsed,
              currency: inferCurrencyFromObject(record),
              basis: `json.${[...path, key].join(".")}`,
              context: JSON.stringify(record).slice(0, 500)
            });
          }
        }

        walk(nestedValue, [...path, key]);
      }
    }
  }

  walk(value, []);

  return prices;
}

function extractLooseScriptPrices(scriptContent: string): ExtractedPrice[] {
  const prices: ExtractedPrice[] = [];

  const loosePatterns = [
    /"(?:(?:ct_)?market_price|marketPrice|ctMarketPrice|bestDeal|best_deal|minPrice|min_price|price)"\s*:\s*"?([€$£]?\s*\d{1,6}(?:[.,]\d{1,2})?)"?/gi,
    /(?:ctMarketPrice|ctMinPrice|bestDeal|marketPrice|minPrice|price)\s*[:=]\s*"?([€$£]?\s*\d{1,6}(?:[.,]\d{1,2})?)"?/gi
  ];

  for (const pattern of loosePatterns) {
    for (const match of scriptContent.matchAll(pattern)) {
      const raw = match[1];
      const price = parseCardPrice(raw);
      const currency = parseCurrency(raw?.match(/[€$£]/)?.[0]);

      if (!price || !isUsableCardPrice(price)) continue;

      prices.push({
        price,
        currency,
        basis: "script.loose_price",
        context: getMatchContext(scriptContent, match.index ?? 0, 180)
      });
    }
  }

  return prices;
}

function selectBestExtractedPrice(prices: ExtractedPrice[]): ExtractedPrice | null {
  const trusted = prices
    .filter((entry) => isUsableCardPrice(entry.price))
    .filter((entry) => !isBadPriceContext(entry.context))
    .sort((a, b) => getPriceBasisPriority(b.basis) - getPriceBasisPriority(a.basis));

  return trusted[0] ?? null;
}

function getPriceBasisPriority(basis: string): number {
  const normalized = basis.toLowerCase();

  if (normalized.includes("best deal")) return 100;
  if (normalized.includes("ct min price")) return 95;
  if (normalized.includes("ct market price")) return 90;
  if (normalized.includes("marketprice")) return 85;
  if (normalized.includes("market_price")) return 85;
  if (normalized.includes("mindprice")) return 80;
  if (normalized.includes("min_price")) return 80;
  if (normalized.includes("json")) return 70;
  if (normalized.includes("dom")) return 60;
  if (normalized.includes("script")) return 50;

  return 10;
}

function isTrustedJsonPriceKey(normalizedKey: string): boolean {
  return TRUSTED_JSON_PRICE_KEYS.some(
    (key) => normalizedKey === key.toLowerCase()
  );
}

function parseJsonPriceValue(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;

    if (value > 10000) {
      return Number((value / 100).toFixed(2));
    }

    return value;
  }

  if (typeof value === "string") {
    return parseCardPrice(value);
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;

    const amount =
      record.amount ??
      record.value ??
      record.price ??
      record.cents ??
      record.amountCents ??
      record.amount_cents;

    return parseJsonPriceValue(amount);
  }

  return null;
}

function inferCurrencyFromObject(
  record: Record<string, unknown>
): "EUR" | "USD" | "GBP" | null {
  const raw =
    record.currency ??
    record.currencyCode ??
    record.currency_code ??
    record.symbol ??
    null;

  const value = String(raw || "").toUpperCase();

  if (value === "EUR" || value === "€") return "EUR";
  if (value === "USD" || value === "$") return "USD";
  if (value === "GBP" || value === "£") return "GBP";

  return null;
}

function dedupePrices(prices: ExtractedPrice[]): ExtractedPrice[] {
  const seen = new Set<string>();
  const deduped: ExtractedPrice[] = [];

  for (const price of prices) {
    const key = `${price.price}|${price.currency}|${price.basis}`;

    if (seen.has(key)) continue;
    seen.add(key);

    deduped.push(price);
  }

  return deduped;
}

function extractFirstPriceFromSegment(
  segment: string
): { price: number; currency: "EUR" | "USD" | "GBP" | null } | null {
  if (segment.includes("—") || segment.includes("–")) {
    const currencyInSegment = segment.match(/[€$£]\s*\d{1,6}(?:[.,]\d{1,2})?/);
    if (!currencyInSegment) return null;
  }

  const leading = segment.match(/([€$£])\s*(\d{1,6}(?:[.,]\d{1,2})?)/);

  if (leading) {
    const currency = parseCurrency(leading[1]);
    const price = parseCardPrice(leading[2]);

    if (price && price > 0) {
      return {
        price,
        currency
      };
    }
  }

  const trailing = segment.match(/(\d{1,6}(?:[.,]\d{1,2})?)\s*([€$£])/);

  if (trailing) {
    const price = parseCardPrice(trailing[1]);
    const currency = parseCurrency(trailing[2]);

    if (price && price > 0) {
      return {
        price,
        currency
      };
    }
  }

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

    if (!segment) continue;

    return segment;
  }

  return null;
}

async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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
        Referer: CARDTRADER_BASE_URL
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
  } catch (err) {
    console.log("❌ CT fetch error:", {
      url,
      error: err
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
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
      console.log("❌ CT identity fetch failed:", {
        status: res.status,
        url
      });

      return null;
    }

    return (await res.json()) as T;
  } catch (err) {
    console.log("❌ CT identity fetch error:", {
      url,
      error: err
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseTcgQuery(item: Item): ParsedTcgQuery {
  const rawName = String(item.name || "").trim();
  const platform = String(item.platform || "").trim();
  const region = String(item.region || "").trim();

  const parenthesisMatch = rawName.match(/\(([^)]+)\)/);
  const content = parenthesisMatch?.[1] ?? "";

  const parts = content
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const setCode =
    platform ||
    parts.find((part) => /^[A-Z0-9]{2,8}$/i.test(part)) ||
    null;

  const cardNumber =
    region ||
    parts.find((part) => /^\d+[a-zA-Z]?\/?\d*[a-zA-Z]?$/.test(part)) ||
    rawName.match(/\b(\d+[a-zA-Z]?\/?\d*[a-zA-Z]?)\b/)?.[1] ||
    null;

  const cleanName = rawName
    .replace(/\([^)]*\)/g, "")
    .replace(/\b\d+[a-zA-Z]?\/?\d*[a-zA-Z]?\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    cleanName: cleanName || rawName,
    setCode: setCode ? normalizeSetCode(setCode) : null,
    cardNumber: cardNumber ? normalizeCardNumber(cardNumber) : null
  };
}

function scoreTcgDexCard(parsed: ParsedTcgQuery, card: TcgDexCard): number {
  let score = 0;

  const wanted = normalizeText(parsed.cleanName);
  const name = normalizeText(card.name || "");

  score += similarityScore(wanted, name);

  if (wanted === name) score += 1;
  if (name.includes(wanted)) score += 0.4;

  if (
    parsed.cardNumber &&
    normalizeCardNumber(card.localId || "") === parsed.cardNumber
  ) {
    score += 0.8;
  }

  return score;
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

  if (parsed.setCode) {
    const knownSet = KNOWN_SET_ALIASES[parsed.setCode];
    if (
      knownSet &&
      candidate.setName &&
      normalizeText(candidate.setName).includes(normalizeText(knownSet.name))
    ) {
      score += 0.5;
    }
  }

  return score;
}

function computeConfidence(
  parsed: ParsedTcgQuery,
  candidate: CardTraderCandidate,
  detail: CardTraderDetail
): number {
  let confidence = 0.45;

  confidence += Math.min(0.25, candidate.score * 0.1);

  if (detail.price && detail.price > 0) confidence += 0.2;

  if (
    parsed.cardNumber &&
    candidate.cardNumber &&
    normalizeCardNumber(candidate.cardNumber) === parsed.cardNumber
  ) {
    confidence += 0.15;
  }

  return Math.max(0.45, Math.min(0.93, Number(confidence.toFixed(2))));
}

function isDetailCompatible(
  parsed: ParsedTcgQuery,
  candidate: CardTraderCandidate,
  detail: CardTraderDetail
): boolean {
  const normalizedTitle = normalizeText(detail.title);
  const normalizedName = normalizeText(parsed.cleanName);

  if (!normalizedTitle.includes(normalizedName)) return false;

  if (
    parsed.cardNumber &&
    candidate.cardNumber &&
    normalizeCardNumber(candidate.cardNumber) !== parsed.cardNumber
  ) {
    return false;
  }

  return true;
}

function addCandidate(
  candidates: CardTraderCandidate[],
  seen: Set<string>,
  candidate: CardTraderCandidate
) {
  if (!candidate.url) return;

  if (seen.has(candidate.url)) return;
  seen.add(candidate.url);

  candidates.push(candidate);
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

function parseCurrency(value?: string): "EUR" | "USD" | "GBP" | null {
  if (value === "€") return "EUR";
  if (value === "$") return "USD";
  if (value === "£") return "GBP";
  return null;
}

function isUsableCardPrice(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value < 50000;
}

function isBadPriceContext(value: string): boolean {
  const normalized = normalizeText(value);

  const badTokens = [
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
  ];

  return badTokens.some((token) => normalized.includes(token));
}

function getMatchContext(text: string, index: number, size: number): string {
  return text.slice(Math.max(0, index - size), index + size);
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

function padCardTotal(value?: number | string | null): string | null {
  if (value == null) return null;

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  return String(numeric).padStart(3, "0");
}

function slugify(value: string): string {
  return normalizeText(value)
    .replace(/\bpokemon\b/g, "")
    .replace(/\bpokémon\b/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cleanTitle(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() || "";

    return last
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}