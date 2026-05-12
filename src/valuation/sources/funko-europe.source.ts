import { Item } from "@prisma/client";
import * as cheerio from "cheerio";

import { ScraperSourceResult } from "../scraper.types";
import { normalizeText, similarityScore } from "../utils";

type FunkoCandidate = {
  title: string;
  url: string;
  price: number | null;
  currency: "GBP" | "EUR" | "USD" | null;
  score: number;
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

  const detailHtml = await fetchHtml(best.url);

  let finalTitle = best.title;
  let finalPrice = best.price;
  let finalCurrency = best.currency;

  if (detailHtml) {
    const detail = parseDetailPage(detailHtml, best.url);

    if (detail.title) finalTitle = detail.title;
    if (detail.price && detail.price > 0) finalPrice = detail.price;
    if (detail.currency) finalCurrency = detail.currency;
  }

  if (isBlockedProduct(finalTitle, best.url)) {
    console.log("🧸 FunkoEurope discarded blocked product:", {
      title: finalTitle,
      url: best.url
    });

    return null;
  }

  if (!finalPrice || finalPrice <= 0) {
    console.log("🧸 FunkoEurope matched but no usable price:", {
      title: finalTitle,
      url: best.url
    });

    return null;
  }

  const confidence = computeConfidence(item, query, finalTitle, best.score);

  return {
    price: Number(finalPrice.toFixed(2)),
    currency: finalCurrency ?? "GBP",
    source: "funko_europe",
    confidence,
    matchedTitle: finalTitle,
    matchedUrl: best.url,
    query,
    metadata: {
      provider: "funko_europe",
      currency: finalCurrency ?? "GBP",
      category: item.category,
      platform: item.platform ?? null,
      region: item.region ?? null,
      listingPrice: best.price,
      finalPrice,
      candidate: best,
      candidates: candidates.slice(0, 12)
    }
  };
}

async function searchFunkoEurope(
  item: Item,
  query: string
): Promise<FunkoCandidate[]> {
  const urls = buildSearchUrls(query);
  const allCandidates: FunkoCandidate[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    console.log("🧸 FunkoEurope searching:", url);

    const html = await fetchHtml(url);
    if (!html) continue;

    const candidates = extractCandidates(html, item, query);

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

function buildSearchUrls(query: string): string[] {
  const queries = buildSearchQueries(query);
  const urls: string[] = [];

  for (const searchQuery of queries) {
    const encoded = encodeURIComponent(searchQuery);

    urls.push(
      `${BASE_URL}/search?q=${encoded}`,
      `${BASE_URL}/search?type=product&q=${encoded}`,
      `${BASE_URL}/collections/pop?q=${encoded}`
    );
  }

  return [...new Set(urls)];
}

function buildSearchQueries(query: string): string[] {
  const clean = cleanQueryForSearch(query);
  const withoutPop = clean
    .replace(/\bfunko\b/gi, "")
    .replace(/\bpop\b/gi, "")
    .replace(/[#!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const queries = new Set<string>();

  queries.add(clean);

  if (withoutPop) {
    queries.add(withoutPop);
    queries.add(`Pop ${withoutPop}`);
    queries.add(`Funko Pop ${withoutPop}`);
  }

  return [...queries]
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 4);
}

function extractCandidates(
  html: string,
  item: Item,
  query: string
): FunkoCandidate[] {
  const $ = cheerio.load(html);
  const candidates: FunkoCandidate[] = [];
  const seen = new Set<string>();

  const selectors = [
    "product-card",
    ".product-card",
    ".card",
    ".grid__item",
    "li",
    "article",
    "a[href*='/products/']"
  ];

  for (const selector of selectors) {
    $(selector).each((_, el) => {
      const root = $(el);

      const href =
        root.find("a[href*='/products/']").first().attr("href") ||
        (root.is("a") ? root.attr("href") : "") ||
        "";

      const url = absolutize(href);

      if (!isProductUrl(url)) return;

      const title =
        cleanTitle(root.find("a[href*='/products/']").first().attr("aria-label") || "") ||
        cleanTitle(root.find("a[href*='/products/']").first().attr("title") || "") ||
        cleanTitle(root.find("img").first().attr("alt") || "") ||
        cleanTitle(root.find(".card__heading").first().text()) ||
        cleanTitle(root.find(".product-card__title").first().text()) ||
        cleanTitle(root.find("h2, h3").first().text()) ||
        cleanTitle(root.text()) ||
        titleFromUrl(url);

      if (!title) return;
      if (isBlockedProduct(title, url)) return;

      const priceText =
        root.find(".price").first().text().trim() ||
        root.find("[class*='price']").first().text().trim() ||
        root.text();

      const parsedPrice = parsePrice(priceText);
      const score = scoreCandidate(item, query, title, url);

      if (score < 0.35) return;

      addCandidate(candidates, seen, {
        title,
        url,
        price: parsedPrice.price,
        currency: parsedPrice.currency,
        score
      });
    });
  }

  extractRawProductUrls(html).forEach((url) => {
    const title = titleFromUrl(url);

    if (!title) return;
    if (isBlockedProduct(title, url)) return;

    const score = scoreCandidate(item, query, title, url);

    if (score < 0.35) return;

    addCandidate(candidates, seen, {
      title,
      url,
      price: null,
      currency: null,
      score
    });
  });

  return candidates.sort((a, b) => b.score - a.score);
}

function addCandidate(
  candidates: FunkoCandidate[],
  seen: Set<string>,
  candidate: FunkoCandidate
) {
  const url = normalizeCandidateUrl(candidate.url);

  if (!isProductUrl(url)) return;
  if (seen.has(url)) return;

  const title = cleanTitle(candidate.title || titleFromUrl(url));

  if (!title) return;
  if (isBlockedProduct(title, url)) return;

  seen.add(url);

  candidates.push({
    ...candidate,
    title,
    url
  });
}

function parseDetailPage(
  html: string,
  url: string
): { title: string | null; price: number | null; currency: "GBP" | "EUR" | "USD" | null } {
  const $ = cheerio.load(html);

  const title =
    cleanTitle($("h1").first().text()) ||
    cleanTitle($("meta[property='og:title']").attr("content") || "") ||
    titleFromUrl(url) ||
    null;

  const priceCandidates = [
    $("meta[property='product:price:amount']").attr("content"),
    $("meta[itemprop='price']").attr("content"),
    $("[itemprop='price']").first().attr("content"),
    $("[itemprop='price']").first().text(),
    $(".price").first().text(),
    $("[class*='price']").first().text(),
    extractProductJsonPrice(html)
  ];

  for (const value of priceCandidates) {
    const parsed = parsePrice(value);

    if (parsed.price && parsed.price > 0) {
      console.log("🧸 FunkoEurope detail parsed:", {
        url,
        title,
        price: parsed.price,
        currency: parsed.currency
      });

      return {
        title,
        price: parsed.price,
        currency: parsed.currency
      };
    }
  }

  console.log("🧸 FunkoEurope detail parsed:", {
    url,
    title,
    price: null,
    currency: null
  });

  return {
    title,
    price: null,
    currency: null
  };
}

function extractProductJsonPrice(html: string): string | null {
  const matches = [
    ...html.matchAll(/"price"\s*:\s*"?(\d+(?:[.,]\d+)?)"?/g),
    ...html.matchAll(/"amount"\s*:\s*"?(\d+(?:[.,]\d+)?)"?/g)
  ];

  const prices = matches
    .map((match) => String(match[1] || "").trim())
    .filter(Boolean);

  return prices[0] ?? null;
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

function parsePrice(value: string | null | undefined): {
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

function extractRawProductUrls(html: string): string[] {
  const normalizedHtml = decodeHtml(html)
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/%2F/gi, "/");

  const urls: string[] = [];

  const patterns = [
    /https?:\/\/funkoeurope\.com\/products\/[^"'<>\\\s?]+/gi,
    /\/products\/[^"'<>\\\s?]+/gi
  ];

  for (const pattern of patterns) {
    for (const match of normalizedHtml.matchAll(pattern)) {
      const url = absolutize(match[0]);

      if (isProductUrl(url)) {
        urls.push(url);
      }
    }
  }

  return [...new Set(urls)];
}

function isProductUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes("funkoeurope.com") && parsed.pathname.includes("/products/");
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

  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }

  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `${BASE_URL}${href}`;

  return `${BASE_URL}/${href}`;
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
        "Accept-Language": "en-GB,en;q=0.9,es;q=0.8",
        Referer: BASE_URL
      }
    });

    if (!res.ok) {
      console.log("❌ FunkoEurope fetch failed:", {
        status: res.status,
        url
      });

      return null;
    }

    return await res.text();
  } catch (error) {
    console.log("❌ FunkoEurope fetch error:", {
      url,
      error
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}