import { Item } from "@prisma/client";
import * as cheerio from "cheerio";

import { ScraperSourceResult } from "../scraper.types";
import { normalizeText, similarityScore } from "../utils";

type PriceChartingCandidate = {
  title: string;
  url: string;
  consoleName: string | null;
  loosePrice: number | null;
  cibPrice: number | null;
  newPrice: number | null;
  score: number;
};

const BASE_URL = "https://www.pricecharting.com";
const REQUEST_TIMEOUT_MS = 8000;

export async function getPriceChartingFunkoPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (item.category !== "figure") return null;
  if (normalizePlatform(item.platform) !== "funko_pop") return null;

  const query = cleanQuery(item.name);
  if (!query) return null;

  console.log("📈 PriceCharting Funko called:", {
    itemId: item.id,
    name: item.name,
    category: item.category,
    platform: item.platform,
    region: item.region,
    notes: item.notes
  });

  const candidates = await searchPriceCharting(item, query);

  console.log(
    "📈 PriceCharting Funko candidates:",
    candidates.slice(0, 10).map((candidate) => ({
      title: candidate.title,
      consoleName: candidate.consoleName,
      loosePrice: candidate.loosePrice,
      cibPrice: candidate.cibPrice,
      newPrice: candidate.newPrice,
      score: Number(candidate.score.toFixed(2)),
      url: candidate.url
    }))
  );

  const best = candidates[0];

  if (!best || best.score < 0.6) {
    console.log("📈 PriceCharting Funko no match:", query);
    return null;
  }

  const detail = await fetchDetail(best.url);

  const title = detail?.title || best.title;
  const consoleName = detail?.consoleName || best.consoleName;

  const prices = {
    loose: detail?.prices.loose ?? best.loosePrice,
    cib: detail?.prices.cib ?? best.cibPrice,
    new: detail?.prices.new ?? best.newPrice
  };

  const finalPrice = chooseFunkoMarketPrice(prices);

  if (!finalPrice || finalPrice <= 0) {
    console.log("📈 PriceCharting Funko matched but no usable price:", {
      title,
      url: best.url,
      prices
    });

    return null;
  }

  const confidence = computeConfidence(item, query, title, best.score);

  return {
    price: Number(finalPrice.toFixed(2)),
    currency: "USD",
    source: "pricecharting_funko",
    confidence,
    matchedTitle: title,
    matchedUrl: best.url,
    query,
    metadata: {
      provider: "pricecharting_funko",
      currency: "USD",
      priceBasis: "new",
      prices,
      product: {
        title,
        consoleName,
        productUrl: best.url,
        details: detail?.details ?? {}
      },
      recentSales: detail?.recentSales ?? [],
      candidate: best,
      candidates: candidates.slice(0, 10),
      rawExtractedLabels: detail?.rawExtractedLabels ?? {}
    }
  };
}

async function searchPriceCharting(
  item: Item,
  query: string
): Promise<PriceChartingCandidate[]> {
  const queries = buildSearchQueries(query);
  const allCandidates: PriceChartingCandidate[] = [];
  const seen = new Set<string>();

  for (const searchQuery of queries) {
    const url = `${BASE_URL}/search-products?q=${encodeURIComponent(
      searchQuery
    )}&type=prices`;

    console.log("📈 PriceCharting Funko searching:", url);

    const html = await fetchHtml(url);
    if (!html) continue;

    const candidates = extractSearchCandidates(html, item, query);

    for (const candidate of candidates) {
      const key = normalizeCandidateUrl(candidate.url);

      if (seen.has(key)) continue;
      seen.add(key);

      allCandidates.push(candidate);
    }

    if (allCandidates.length > 0) break;
  }

  return allCandidates.sort((a, b) => b.score - a.score).slice(0, 20);
}

function buildSearchQueries(query: string): string[] {
  const clean = cleanQueryForSearch(query);

  const withoutFunkoPop = clean
    .replace(/\bfunko\b/gi, "")
    .replace(/\bpop\b/gi, "")
    .replace(/[#!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const withoutNumber = withoutFunkoPop
    .replace(/\b\d{2,5}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const number = extractBoxNumber(clean);

  const queries = new Set<string>();

  queries.add(clean);

  if (withoutFunkoPop) queries.add(withoutFunkoPop);
  if (number && withoutNumber) queries.add(`${withoutNumber} ${number}`);
  if (number) queries.add(number);

  return [...queries]
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 5);
}

function extractSearchCandidates(
  html: string,
  item: Item,
  query: string
): PriceChartingCandidate[] {
  const $ = cheerio.load(html);
  const candidates: PriceChartingCandidate[] = [];
  const seen = new Set<string>();

  $("tr").each((_, row) => {
    const root = $(row);

    const href =
      root.find("a[href*='/game/funko-pop-']").first().attr("href") ||
      root.find("a[href*='/game/']").first().attr("href") ||
      "";

    const url = absolutize(href);
    if (!isFunkoProductUrl(url)) return;

    const title =
      cleanTitle(root.find("a[href*='/game/']").first().text()) ||
      titleFromUrl(url);

    if (!title) return;

    const rowText = normalizeWhitespace(root.text());
    const consoleName = extractConsoleName(rowText);
    const prices = extractPricesFromText(rowText);

    const score = scoreCandidate(item, query, title, url, consoleName);

    if (score < 0.35) return;

    addCandidate(candidates, seen, {
      title,
      url,
      consoleName,
      loosePrice: prices.loose,
      cibPrice: prices.cib,
      newPrice: prices.new,
      score
    });
  });

  $("a[href*='/game/funko-pop-']").each((_, link) => {
    const href = $(link).attr("href") || "";
    const url = absolutize(href);

    if (!isFunkoProductUrl(url)) return;

    const title = cleanTitle($(link).text()) || titleFromUrl(url);
    if (!title) return;

    const root = $(link).closest("tr, li, div, article");
    const rootText = normalizeWhitespace(root.text());
    const consoleName = extractConsoleName(rootText);
    const prices = extractPricesFromText(rootText);

    const score = scoreCandidate(item, query, title, url, consoleName);

    if (score < 0.35) return;

    addCandidate(candidates, seen, {
      title,
      url,
      consoleName,
      loosePrice: prices.loose,
      cibPrice: prices.cib,
      newPrice: prices.new,
      score
    });
  });

  return candidates.sort((a, b) => b.score - a.score);
}

function addCandidate(
  candidates: PriceChartingCandidate[],
  seen: Set<string>,
  candidate: PriceChartingCandidate
) {
  const url = normalizeCandidateUrl(candidate.url);

  if (!isFunkoProductUrl(url)) return;
  if (seen.has(url)) return;

  seen.add(url);

  candidates.push({
    ...candidate,
    url
  });
}

async function fetchDetail(url: string): Promise<{
  title: string | null;
  consoleName: string | null;
  prices: {
    loose: number | null;
    cib: number | null;
    new: number | null;
  };
  details: Record<string, string | number | null>;
  recentSales: Array<{
    date: string | null;
    title: string | null;
    price: number | null;
    source: string | null;
  }>;
  rawExtractedLabels: Record<string, string>;
} | null> {
  const html = await fetchHtml(url);
  if (!html) return null;

  const $ = cheerio.load(html);

  const title =
    cleanTitle($("h1").first().text()) ||
    cleanTitle($("title").first().text()).replace(/\s*prices.*$/i, "") ||
    titleFromUrl(url) ||
    null;

  const bodyText = normalizeWhitespace($("body").text());

  const prices = extractDetailPrices($, bodyText);
  const details = extractDetails($);
  const recentSales = extractRecentSales($);
  const rawExtractedLabels = extractRawLabels(bodyText);

  const consoleName =
    cleanTitle(String(details.consoleName ?? "")) ||
    extractConsoleName(bodyText);

  console.log("📈 PriceCharting Funko detail parsed:", {
    url,
    title,
    consoleName,
    prices,
    recentSales: recentSales.slice(0, 5)
  });

  return {
    title,
    consoleName,
    prices,
    details,
    recentSales,
    rawExtractedLabels
  };
}

function extractDetailPrices(
  $: cheerio.CheerioAPI,
  bodyText: string
): {
  loose: number | null;
  cib: number | null;
  new: number | null;
} {
  const tableText = normalizeWhitespace(
    $("table, .price, #full-prices, #price_data, body").text()
  );

  const combined = `${tableText} ${bodyText}`;

  const loose =
    extractPriceAfterLabels(combined, ["Out of Box", "Loose Price", "Loose"]) ??
    null;

  const cib =
    extractPriceAfterLabels(combined, ["In Box", "CIB Price", "Complete"]) ??
    null;

  const newPrice =
    extractPriceAfterLabels(combined, ["New Price", "New"]) ??
    null;

  return {
    loose,
    cib,
    new: newPrice
  };
}

function extractPriceAfterLabels(
  text: string,
  labels: string[]
): number | null {
  for (const label of labels) {
    const escaped = escapeRegExp(label);
    const pattern = new RegExp(`${escaped}\\s*\\$\\s*(\\d{1,6}(?:\\.\\d{1,2})?)`, "i");
    const match = text.match(pattern);

    if (!match?.[1]) continue;

    const price = Number(match[1]);

    if (Number.isFinite(price) && price > 0) {
      return price;
    }
  }

  return null;
}

function extractPricesFromText(text: string): {
  loose: number | null;
  cib: number | null;
  new: number | null;
} {
  const prices = [...text.matchAll(/\$\s*(\d{1,6}(?:\.\d{1,2})?)/g)]
    .map((match) => Number(match[1]))
    .filter((price) => Number.isFinite(price) && price > 0 && price < 100000);

  return {
    loose: prices[0] ?? null,
    cib: prices[1] ?? null,
    new: prices[2] ?? null
  };
}

function extractRawLabels(text: string): Record<string, string> {
  const labels = ["Out of Box", "In Box", "New", "Loose", "CIB", "PriceCharting ID"];
  const result: Record<string, string> = {};

  for (const label of labels) {
    const escaped = escapeRegExp(label);
    const pattern = new RegExp(`${escaped}\\s*([^\\n]{0,80})`, "i");
    const match = text.match(pattern);

    if (match?.[1]) {
      result[label] = match[1].trim();
    }
  }

  return result;
}

function extractDetails($: cheerio.CheerioAPI): Record<string, string | number | null> {
  const details: Record<string, string | number | null> = {};

  const bodyText = normalizeWhitespace($("body").text());

  const knownLabels = [
    "Series",
    "Release Date",
    "Publisher",
    "Box Number",
    "Print Run",
    "Notes",
    "UPC",
    "ASIN",
    "ePID",
    "PriceCharting ID"
  ];

  for (const label of knownLabels) {
    const value = extractValueAfterLabel(bodyText, label);

    if (value) {
      details[toCamelCase(label)] = value;
    }
  }

  const h1 = cleanTitle($("h1").first().text());
  if (h1) details.title = h1;

  const titleParts = h1.match(/\(([^)]+)\)/);
  if (titleParts?.[1]) {
    details.consoleName = titleParts[1].trim();
  }

  return details;
}

function extractValueAfterLabel(text: string, label: string): string | null {
  const escaped = escapeRegExp(label);
  const pattern = new RegExp(`${escaped}:?\\s*([^\\n]{1,120})`, "i");
  const match = text.match(pattern);

  if (!match?.[1]) return null;

  return match[1]
    .replace(/\s{2,}.*/, "")
    .replace(/Full Price Guide.*$/i, "")
    .trim();
}

function extractRecentSales($: cheerio.CheerioAPI): Array<{
  date: string | null;
  title: string | null;
  price: number | null;
  source: string | null;
}> {
  const sales: Array<{
    date: string | null;
    title: string | null;
    price: number | null;
    source: string | null;
  }> = [];

  $("tr").each((_, row) => {
    const root = $(row);
    const text = normalizeWhitespace(root.text());

    if (!text.includes("$")) return;
    if (!/\d{4}-\d{2}-\d{2}/.test(text)) return;

    const date = text.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
    const price = extractFirstUsdPrice(text);
    const source = text.includes("eBay") ? "ebay" : null;

    const title =
      cleanTitle(root.find("a").first().text()) ||
      cleanTitle(text.replace(/\$\s*\d{1,6}(?:\.\d{1,2})?.*/, ""));

    if (!price || !title) return;

    sales.push({
      date,
      title,
      price,
      source
    });
  });

  return sales.slice(0, 20);
}

function extractFirstUsdPrice(text: string): number | null {
  const match = text.match(/\$\s*(\d{1,6}(?:\.\d{1,2})?)/);

  if (!match?.[1]) return null;

  const price = Number(match[1]);

  return Number.isFinite(price) && price > 0 ? price : null;
}

function chooseFunkoMarketPrice(prices: {
  loose: number | null;
  cib: number | null;
  new: number | null;
}): number | null {
  if (prices.new && prices.new > 0) return prices.new;
  if (prices.cib && prices.cib > 0) return prices.cib;
  if (prices.loose && prices.loose > 0) return prices.loose;

  return null;
}

function scoreCandidate(
  item: Item,
  query: string,
  title: string,
  url: string,
  consoleName: string | null
): number {
  const wanted = normalizeSearchText(query);
  const normalizedTitle = normalizeSearchText(title);
  const normalizedUrl = normalizeSearchText(url);
  const normalizedConsole = normalizeSearchText(consoleName ?? "");

  let score = similarityScore(wanted, normalizedTitle);

  if (normalizedTitle === wanted) score += 1;
  if (normalizedTitle.includes(wanted)) score += 0.7;

  const wantedTokens = getImportantTokens(normalizeSearchText(item.name));
  const matchedTokens = wantedTokens.filter(
    (token) =>
      normalizedTitle.includes(token) ||
      normalizedUrl.includes(token) ||
      normalizedConsole.includes(token)
  );

  if (wantedTokens.length > 0) {
    score += (matchedTokens.length / wantedTokens.length) * 0.9;
  }

  const wantedBoxNumber = extractBoxNumber(item.name);
  const titleBoxNumber = extractBoxNumber(title);

  if (wantedBoxNumber && titleBoxNumber && wantedBoxNumber === titleBoxNumber) {
    score += 0.6;
  }

  if (normalizedUrl.includes("funko-pop")) score += 0.25;
  if (normalizedConsole.includes("funko pop")) score += 0.25;

  if (wantedBoxNumber && titleBoxNumber && wantedBoxNumber !== titleBoxNumber) {
    score -= 1.1;
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

  if (matched === wanted) confidence += 0.18;
  if (matched.includes(wanted)) confidence += 0.12;

  if (wantedTokens.length > 0) {
    confidence += (matchedTokens.length / wantedTokens.length) * 0.18;
  }

  const wantedBoxNumber = extractBoxNumber(item.name);
  const matchedBoxNumber = extractBoxNumber(title);

  if (wantedBoxNumber && matchedBoxNumber && wantedBoxNumber === matchedBoxNumber) {
    confidence += 0.12;
  }

  return Math.max(0.35, Math.min(0.93, Number(confidence.toFixed(2))));
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

function extractBoxNumber(value: string): string | null {
  const text = String(value || "");

  const hashMatch = text.match(/#\s*(\d{1,5})/);
  if (hashMatch?.[1]) return hashMatch[1];

  const numberMatch = text.match(/\b(\d{2,5})\b/);
  if (numberMatch?.[1]) return numberMatch[1];

  return null;
}

function extractConsoleName(text: string): string | null {
  const match = text.match(/Funko POP\s+[A-Za-z0-9 '&:/.-]+/i);

  if (!match?.[0]) return null;

  return cleanTitle(match[0]);
}

function isFunkoProductUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    return (
      parsed.hostname.includes("pricecharting.com") &&
      parsed.pathname.includes("/game/funko-pop-")
    );
  } catch {
    return false;
  }
}

function normalizeCandidateUrl(url: string): string {
  try {
    const parsed = new URL(url);

    parsed.hash = "";

    return parsed.toString();
  } catch {
    return url;
  }
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() || "";

    return cleanTitle(
      last
        .replace(/-/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
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
    .replace(/\s*\|\s*.*$/g, "")
    .replace(/\s*Prices\s*$/gi, "")
    .replace(/\s*New\s*&\s*Loose\s*Values\s*$/gi, "")
    .trim();
}

function normalizeWhitespace(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function toCamelCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+(.)/g, (_, chr: string) => chr.toUpperCase())
    .replace(/[^a-z0-9]/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
        "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
        Referer: BASE_URL
      }
    });

    if (!res.ok) {
      console.log("❌ PriceCharting Funko fetch failed:", {
        status: res.status,
        url
      });

      return null;
    }

    return await res.text();
  } catch (error) {
    console.log("❌ PriceCharting Funko fetch error:", {
      url,
      error
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}