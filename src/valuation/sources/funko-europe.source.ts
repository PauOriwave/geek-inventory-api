import { Item } from "@prisma/client";

import { ScraperSourceResult } from "../scraper.types";
import { normalizeText, similarityScore } from "../utils";

type FunkoCandidate = {
  title: string;
  url: string;
  price: number | null;
  currency: "GBP" | "EUR" | "USD" | null;
  score: number;
};

type ShopifyPredictiveProduct = {
  title?: string;
  url?: string;
  price?: string;
  price_min?: string | number;
  price_max?: string | number;
  compare_at_price?: string | number;
  image?: string;
  vendor?: string;
  product_type?: string;
};

const BASE_URL = "https://funkoeurope.com";
const REQUEST_TIMEOUT_MS = 8000;

const BLOCKED_TERMS = [
  "loungefly",
  "backpack",
  "mini backpack",
  "wallet",
  "bag",
  "apparel",
  "t-shirt",
  "shirt",
  "hoodie",
  "cap",
  "hat",
  "pin",
  "keychain",
  "key chain",
  "plush",
  "plushies",
  "soda",
  "bitty pop",
  "mystery mini",
  "premium blind box",
  "pop yourself",
  "poster",
  "mug"
];

export async function getFunkoEuropePrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (item.category !== "figure") return null;
  if (normalizePlatform(item.platform) !== "funko_pop") return null;

  const query = cleanQuery(item.name);
  if (!query) return null;

  console.log("🧸 FunkoEurope called:", {
    itemId: item.id,
    name: item.name,
    category: item.category,
    platform: item.platform,
    region: item.region,
    notes: item.notes
  });

  const candidates = await searchFunkoEurope(item, query);

  console.log(
    "🧸 FunkoEurope candidates:",
    candidates.slice(0, 12).map((candidate) => ({
      title: candidate.title,
      price: candidate.price,
      currency: candidate.currency,
      score: Number(candidate.score.toFixed(2)),
      url: candidate.url
    }))
  );

  const best = candidates[0];

  if (!best || best.score < 0.55) {
    console.log("🧸 FunkoEurope no match:", query);
    return null;
  }

  if (!best.price || best.price <= 0) {
    console.log("🧸 FunkoEurope matched but no usable price:", {
      title: best.title,
      url: best.url
    });

    return null;
  }

  const confidence = computeConfidence(item, query, best.title, best.score);

  return {
    price: Number(best.price.toFixed(2)),
    currency: best.currency ?? "GBP",
    source: "funko_europe",
    confidence,
    matchedTitle: best.title,
    matchedUrl: best.url,
    query,
    metadata: {
      provider: "funko_europe",
      currency: best.currency ?? "GBP",
      category: item.category,
      platform: item.platform ?? null,
      region: item.region ?? null,
      finalPrice: best.price,
      candidate: best,
      candidates: candidates.slice(0, 12)
    }
  };
}

async function searchFunkoEurope(
  item: Item,
  query: string
): Promise<FunkoCandidate[]> {
  const queries = buildSearchQueries(query);
  const allCandidates: FunkoCandidate[] = [];
  const seen = new Set<string>();

  for (const searchQuery of queries) {
    const url = buildPredictiveSearchUrl(searchQuery);

    console.log("🧸 FunkoEurope searching JSON:", url);

    const json = await fetchJson(url);
    if (!json) continue;

    const candidates = extractCandidatesFromPredictiveJson(json, item, query);

    for (const candidate of candidates) {
      const key = normalizeCandidateUrl(candidate.url);

      if (seen.has(key)) continue;
      seen.add(key);

      allCandidates.push(candidate);
    }

    if (allCandidates.length > 0) break;
  }

  return allCandidates.sort((a, b) => b.score - a.score).slice(0, 30);
}

function buildPredictiveSearchUrl(query: string): string {
  const encoded = encodeURIComponent(query);

  return `${BASE_URL}/search/suggest.json?q=${encoded}&resources[type]=product&resources[limit]=10`;
}

function buildSearchQueries(query: string): string[] {
  const clean = cleanQueryForSearch(query);

  const withoutPop = clean
    .replace(/\bfunko\b/gi, "")
    .replace(/\bpop\b/gi, "")
    .replace(/[#!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const withoutNumber = withoutPop
    .replace(/\b\d{2,5}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const queries = new Set<string>();

  queries.add(clean);

  if (withoutPop) {
    queries.add(withoutPop);
    queries.add(`Pop ${withoutPop}`);
    queries.add(`Funko Pop ${withoutPop}`);
  }

  if (withoutNumber) {
    queries.add(withoutNumber);
    queries.add(`Pop ${withoutNumber}`);
  }

  return [...queries]
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 5);
}

function extractCandidatesFromPredictiveJson(
  json: unknown,
  item: Item,
  query: string
): FunkoCandidate[] {
  const products = extractProducts(json);
  const candidates: FunkoCandidate[] = [];

  for (const product of products) {
    const title = cleanTitle(product.title ?? "");
    const url = absolutize(product.url ?? "");

    if (!title || !isProductUrl(url)) continue;
    if (isBlockedProduct(title, url)) continue;

    const parsedPrice = parseProductPrice(product);
    const score = scoreCandidate(item, query, title, url);

    if (score < 0.35) continue;

    candidates.push({
      title,
      url,
      price: parsedPrice.price,
      currency: parsedPrice.currency,
      score
    });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

function extractProducts(json: unknown): ShopifyPredictiveProduct[] {
  if (!json || typeof json !== "object") return [];

  const root = json as Record<string, unknown>;
  const resources = root.resources as Record<string, unknown> | undefined;
  const results = resources?.results as Record<string, unknown> | undefined;
  const products = results?.products;

  if (Array.isArray(products)) {
    return products as ShopifyPredictiveProduct[];
  }

  return [];
}

function parseProductPrice(product: ShopifyPredictiveProduct): {
  price: number | null;
  currency: "GBP" | "EUR" | "USD" | null;
} {
  const candidates = [
    product.price,
    product.price_min,
    product.price_max,
    product.compare_at_price
  ];

  for (const candidate of candidates) {
    const parsed = parsePrice(candidate);

    if (parsed.price && parsed.price > 0) {
      return parsed;
    }
  }

  return {
    price: null,
    currency: null
  };
}

function scoreCandidate(
  item: Item,
  query: string,
  title: string,
  url: string
): number {
  const wanted = normalizeSearchText(query);
  const normalizedTitle = normalizeSearchText(title);
  const normalizedUrl = normalizeSearchText(url);

  let score = similarityScore(wanted, normalizedTitle);

  if (normalizedTitle === wanted) score += 1;
  if (normalizedTitle.includes(wanted)) score += 0.7;
  if (normalizedUrl.includes(wanted.replace(/\s+/g, "-"))) score += 0.4;

  const wantedTokens = getImportantTokens(normalizeSearchText(item.name));
  const matchedTokens = wantedTokens.filter(
    (token) => normalizedTitle.includes(token) || normalizedUrl.includes(token)
  );

  if (wantedTokens.length > 0) {
    score += (matchedTokens.length / wantedTokens.length) * 0.85;
  }

  if (isFunkoPopSignal(title, url)) {
    score += 0.25;
  }

  if (isBlockedProduct(title, url)) {
    score -= 1.2;
  }

  return Number(score.toFixed(4));
}

function computeConfidence(
  item: Item,
  query: string,
  title: string,
  score: number
): number {
  const wanted = normalizeSearchText(query);
  const matched = normalizeSearchText(title);

  const wantedTokens = getImportantTokens(normalizeSearchText(item.name));
  const matchedTokens = wantedTokens.filter((token) => matched.includes(token));

  let confidence = 0.45;

  confidence += Math.min(0.25, score * 0.12);

  if (matched === wanted) confidence += 0.22;
  if (matched.includes(wanted)) confidence += 0.15;

  if (wantedTokens.length > 0) {
    confidence += (matchedTokens.length / wantedTokens.length) * 0.18;
  }

  if (isFunkoPopSignal(title, "")) {
    confidence += 0.08;
  }

  if (isBlockedProduct(title, "")) {
    confidence -= 0.35;
  }

  return Math.max(0.35, Math.min(0.92, Number(confidence.toFixed(2))));
}

function parsePrice(value: unknown): {
  price: number | null;
  currency: "GBP" | "EUR" | "USD" | null;
} {
  const text = String(value || "").trim();

  if (!text) {
    return {
      price: null,
      currency: null
    };
  }

  const currency = detectCurrency(text);

  const symbolPatterns = [
    /£\s*(\d{1,5}(?:[.,]\d{1,2})?)/,
    /€\s*(\d{1,5}(?:[.,]\d{1,2})?)/,
    /\$\s*(\d{1,5}(?:[.,]\d{1,2})?)/,
    /(\d{1,5}(?:[.,]\d{1,2})?)\s*(?:GBP|EUR|USD)/i
  ];

  for (const pattern of symbolPatterns) {
    const match = text.match(pattern);

    if (!match?.[1]) continue;

    const parsed = Number(match[1].replace(",", "."));

    if (Number.isFinite(parsed) && parsed > 0) {
      return {
        price: parsed,
        currency
      };
    }
  }

  const numeric = Number(text.replace(",", "."));

  if (Number.isFinite(numeric) && numeric > 0) {
    return {
      price: numeric > 1000 ? numeric / 100 : numeric,
      currency
    };
  }

  return {
    price: null,
    currency
  };
}

function detectCurrency(value: string): "GBP" | "EUR" | "USD" | null {
  const text = value.toUpperCase();

  if (text.includes("£") || text.includes("GBP")) return "GBP";
  if (text.includes("€") || text.includes("EUR")) return "EUR";
  if (text.includes("$") || text.includes("USD")) return "USD";

  return null;
}

function getImportantTokens(normalizedText: string): string[] {
  const stopWords = new Set([
    "funko",
    "pop",
    "vinyl",
    "figure",
    "figura",
    "collectible",
    "collectibles",
    "the",
    "and",
    "de",
    "la",
    "el",
    "los",
    "las",
    "a",
    "an"
  ]);

  return normalizedText
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length > 2)
    .filter((token) => !stopWords.has(token));
}

function isFunkoPopSignal(title: string, url: string): boolean {
  const text = normalizeSearchText(`${title} ${url}`);

  return (
    text.includes("pop") ||
    text.includes("funko") ||
    text.includes("/products/")
  );
}

function isBlockedProduct(title: string, url: string): boolean {
  const text = normalizeSearchText(`${title} ${url}`);

  return BLOCKED_TERMS.some((term) =>
    text.includes(normalizeSearchText(term))
  );
}

function isProductUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    return (
      parsed.hostname.includes("funkoeurope.com") &&
      parsed.pathname.includes("/products/")
    );
  } catch {
    return false;
  }
}

function normalizeCandidateUrl(url: string): string {
  try {
    const parsed = new URL(url);

    parsed.hash = "";
    parsed.search = "";

    return parsed.toString();
  } catch {
    return url;
  }
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

  return normalized;
}

function normalizeSearchText(value: string): string {
  return normalizeText(value)
    .replace(/[™®©]/g, "")
    .replace(/[#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanQuery(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanQueryForSearch(value: string): string {
  return String(value || "")
    .replace(/[™®©]/g, "")
    .replace(/[#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTitle(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/Add to Cart/gi, "")
    .replace(/Sold Out/gi, "")
    .replace(/Low Stock/gi, "")
    .replace(/Notify Me/gi, "")
    .trim();
}

function absolutize(href: string): string {
  if (!href) return "";

  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }

  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `${BASE_URL}${href}`;

  return `${BASE_URL}/${href}`;
}

async function fetchJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127.0 Safari/537.36",
        Accept: "application/json",
        "Accept-Language": "en-GB,en;q=0.9,es;q=0.8",
        Referer: BASE_URL
      }
    });

    if (!res.ok) {
      console.log("❌ FunkoEurope JSON fetch failed:", {
        status: res.status,
        url
      });

      return null;
    }

    const contentType = res.headers.get("content-type") || "";
    const text = await res.text();

    if (!contentType.includes("application/json")) {
      console.log("❌ FunkoEurope returned non-json response:", {
        contentType,
        url,
        preview: text.slice(0, 120)
      });

      return null;
    }

    return JSON.parse(text);
  } catch (error) {
    console.log("❌ FunkoEurope JSON fetch error:", {
      url,
      error
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}