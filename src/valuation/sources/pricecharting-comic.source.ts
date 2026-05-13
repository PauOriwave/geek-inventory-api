import { Item } from "@prisma/client";
import * as cheerio from "cheerio";

import { ScraperSourceResult } from "../scraper.types";
import { normalizeText, similarityScore } from "../utils";

type PriceChartingComicCandidate = {
  title: string;
  url: string;
  consoleName: string | null;
  ungradedPrice: number | null;
  gradedPrice: number | null;
  score: number;
};

type DetailResult = {
  title: string | null;
  consoleName: string | null;
  prices: {
    ungraded: number | null;
    graded: number | null;
  };
  details: Record<string, string | number | null>;
  recentSales: Array<{
    date: string | null;
    title: string | null;
    price: number | null;
    source: string | null;
  }>;
  rawExtractedLabels: Record<string, string>;
};

const BASE_URL = "https://www.pricecharting.com";
const REQUEST_TIMEOUT_MS = 8000;

export async function getPriceChartingComicPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (item.category !== "comic") return null;

  const query = cleanQuery(item.name);
  if (!query) return null;

  console.log("📈 PriceCharting Comic called:", {
    itemId: item.id,
    name: item.name,
    category: item.category,
    platform: item.platform,
    region: item.region,
    condition: item.condition,
    notes: item.notes
  });

  const candidates = await searchPriceCharting(item, query);

  console.log(
    "📈 PriceCharting Comic candidates:",
    candidates.slice(0, 10).map((candidate) => ({
      title: candidate.title,
      consoleName: candidate.consoleName,
      ungradedPrice: candidate.ungradedPrice,
      gradedPrice: candidate.gradedPrice,
      score: Number(candidate.score.toFixed(2)),
      url: candidate.url
    }))
  );

  const best = candidates[0];

  if (!best || best.score < 0.58) {
    console.log("📈 PriceCharting Comic no match:", query);
    return null;
  }

  const detail = await fetchDetail(best.url);

  const title = detail?.title || best.title;
  const consoleName = detail?.consoleName || best.consoleName;

  const prices = {
    ungraded: detail?.prices.ungraded ?? best.ungradedPrice,
    graded: detail?.prices.graded ?? best.gradedPrice
  };

  const priceBasis = choosePriceBasis(item);
  const finalPrice = chooseMarketPrice(prices, priceBasis);

  if (!finalPrice || finalPrice <= 0) {
    console.log("📈 PriceCharting Comic matched but no usable price:", {
      title,
      consoleName,
      url: best.url,
      prices,
      priceBasis
    });

    return null;
  }

  const confidence = computeConfidence(item, query, title, consoleName, best.score);

  return {
    price: Number(finalPrice.toFixed(2)),
    currency: "USD",
    source: "pricecharting_comic",
    confidence,
    matchedTitle: title,
    matchedUrl: best.url,
    query,
    metadata: {
      provider: "pricecharting_comic",
      currency: "USD",
      priceBasis,
      prices,
      product: {
        title,
        consoleName,
        productUrl: best.url,
        details: detail?.details ?? {}
      },
      itemContext: {
        condition: item.condition ?? null,
        notes: item.notes ?? null,
        platform: item.platform ?? null,
        region: item.region ?? null
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
): Promise<PriceChartingComicCandidate[]> {
  const queries = buildSearchQueries(query);
  const allCandidates: PriceChartingComicCandidate[] = [];
  const seen = new Set<string>();

  for (const searchQuery of queries) {
    const url = `${BASE_URL}/search-products?q=${encodeURIComponent(
      searchQuery
    )}&type=prices`;

    console.log("📈 PriceCharting Comic searching:", url);

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
  const withoutVolumeNoise = clean
    .replace(/\bvol\.?\s*/gi, "")
    .replace(/\bvolume\s*/gi, "")
    .replace(/\btomo\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const queries = new Set<string>();

  queries.add(clean);

  if (withoutVolumeNoise) {
    queries.add(withoutVolumeNoise);
  }

  const issueQuery = normalizeComicIssueQuery(withoutVolumeNoise || clean);
  if (issueQuery) queries.add(issueQuery);

  const withoutIssue = removeTrailingIssueNumber(withoutVolumeNoise || clean);
  if (withoutIssue && withoutIssue !== clean) queries.add(withoutIssue);

  return [...queries]
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 6);
}

function extractSearchCandidates(
  html: string,
  item: Item,
  query: string
): PriceChartingComicCandidate[] {
  const $ = cheerio.load(html);
  const candidates: PriceChartingComicCandidate[] = [];
  const seen = new Set<string>();

  $("tr").each((_, row) => {
    const root = $(row);

    const href = root.find("a[href*='/game/']").first().attr("href") || "";
    const url = absolutize(href);

    if (!isComicProductUrl(url)) return;

    const title =
      cleanTitle(root.find("a[href*='/game/']").first().text()) ||
      titleFromUrl(url);

    if (!title) return;

    const rowText = normalizeWhitespace(root.text());
    const consoleName = extractConsoleNameFromRow(rowText, url);
    const prices = extractPricesFromText(rowText);
    const score = scoreCandidate(item, query, title, url, consoleName);

    if (score < 0.35) return;

    addCandidate(candidates, seen, {
      title,
      url,
      consoleName,
      ungradedPrice: prices.ungraded,
      gradedPrice: prices.graded,
      score
    });
  });

  $("a[href*='/game/']").each((_, link) => {
    const href = $(link).attr("href") || "";
    const url = absolutize(href);

    if (!isComicProductUrl(url)) return;

    const title = cleanTitle($(link).text()) || titleFromUrl(url);
    if (!title) return;

    const root = $(link).closest("tr, li, div, article");
    const rootText = normalizeWhitespace(root.text());
    const consoleName = extractConsoleNameFromRow(rootText, url);
    const prices = extractPricesFromText(rootText);
    const score = scoreCandidate(item, query, title, url, consoleName);

    if (score < 0.35) return;

    addCandidate(candidates, seen, {
      title,
      url,
      consoleName,
      ungradedPrice: prices.ungraded,
      gradedPrice: prices.graded,
      score
    });
  });

  return candidates.sort((a, b) => b.score - a.score);
}

function addCandidate(
  candidates: PriceChartingComicCandidate[],
  seen: Set<string>,
  candidate: PriceChartingComicCandidate
) {
  const url = normalizeCandidateUrl(candidate.url);

  if (!isComicProductUrl(url)) return;
  if (seen.has(url)) return;

  seen.add(url);

  candidates.push({
    ...candidate,
    url
  });
}

async function fetchDetail(url: string): Promise<DetailResult | null> {
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
  const details = extractDetails($, url);
  const recentSales = extractRecentSales($);
  const rawExtractedLabels = extractRawLabels(bodyText);

  const consoleName =
    cleanSafeConsoleName(String(details.consoleName ?? "")) ||
    extractConsoleNameFromTitle(title ?? "") ||
    extractConsoleNameFromUrl(url) ||
    null;

  if (consoleName) {
    details.consoleName = consoleName;
  }

  console.log("📈 PriceCharting Comic detail parsed:", {
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
  ungraded: number | null;
  graded: number | null;
} {
  const combined = normalizeWhitespace(
    `${$("table, .price, #full-prices, #price_data, body").text()} ${bodyText}`
  );

  const ungraded =
    extractPriceAfterLabels(combined, [
      "Ungraded Price",
      "Ungraded",
      "Raw Price",
      "Raw"
    ]) ?? null;

  const graded =
    extractPriceAfterLabels(combined, [
      "Graded Price",
      "Graded",
      "CGC 9.8",
      "PSA 10"
    ]) ?? null;

  return {
    ungraded,
    graded
  };
}

function extractPriceAfterLabels(text: string, labels: string[]): number | null {
  for (const label of labels) {
    const escaped = escapeRegExp(label);
    const pattern = new RegExp(
      `${escaped}\\s*\\$\\s*(\\d{1,6}(?:\\.\\d{1,2})?)`,
      "i"
    );
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
  ungraded: number | null;
  graded: number | null;
} {
  const prices = [...text.matchAll(/\$\s*(\d{1,6}(?:\.\d{1,2})?)/g)]
    .map((match) => Number(match[1]))
    .filter((price) => Number.isFinite(price) && price > 0 && price < 100000);

  return {
    ungraded: prices[0] ?? null,
    graded: prices[1] ?? null
  };
}

function extractDetails(
  $: cheerio.CheerioAPI,
  url: string
): Record<string, string | number | null> {
  const details: Record<string, string | number | null> = {};
  const bodyText = normalizeWhitespace($("body").text());

  const knownLabels = [
    "Comic Book",
    "Series",
    "Issue",
    "Publisher",
    "Release Date",
    "Cover Price",
    "Genre",
    "PriceCharting ID"
  ];

  for (const label of knownLabels) {
    const value = extractValueAfterLabel(bodyText, label);

    if (value && isSafeDetailValue(value)) {
      details[toCamelCase(label)] = value;
    }
  }

  const h1 = cleanTitle($("h1").first().text());
  if (h1) details.title = h1;

  const consoleFromTitle = extractConsoleNameFromTitle(h1);
  const consoleFromUrl = extractConsoleNameFromUrl(url);

  details.consoleName = consoleFromTitle || consoleFromUrl;

  return details;
}

function extractValueAfterLabel(text: string, label: string): string | null {
  const escaped = escapeRegExp(label);
  const pattern = new RegExp(`${escaped}:?\\s*([^\\n]{1,120})`, "i");
  const match = text.match(pattern);

  if (!match?.[1]) return null;

  const value = match[1]
    .replace(/\s{2,}.*/, "")
    .replace(/Full Price Guide.*$/i, "")
    .trim();

  return isSafeDetailValue(value) ? value : null;
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
    if (isNonSaleRow(text)) return;

    const date = text.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
    const price = extractFirstUsdPrice(text);
    const source = text.toLowerCase().includes("ebay") ? "ebay" : null;

    const anchorTexts = root
      .find("a")
      .map((_, link) => cleanSaleTitle($(link).text()))
      .get()
      .filter(Boolean);

    const title =
      anchorTexts.find((value) => !isBadSaleTitle(value)) ||
      cleanSaleTitle(text.replace(/\$\s*\d{1,6}(?:\.\d{1,2})?.*/, ""));

    if (!price || !title || isBadSaleTitle(title)) return;

    sales.push({
      date,
      title,
      price,
      source
    });
  });

  return sales.slice(0, 20);
}

function isNonSaleRow(text: string): boolean {
  const normalized = normalizeSearchText(text);

  return (
    normalized.includes("time warp") ||
    normalized.includes("subscribe") ||
    normalized.includes("photos of completed sales") ||
    normalized.includes("remove ads") ||
    normalized.includes("pricecharting pro")
  );
}

function isBadSaleTitle(value: string): boolean {
  const normalized = normalizeSearchText(value);

  if (!normalized) return true;
  if (normalized.length < 4) return true;

  return (
    normalized === "buy" ||
    normalized === "view" ||
    normalized === "subscribe" ||
    normalized.includes("time warp") ||
    normalized.includes("completed sales") ||
    normalized.includes("pricecharting")
  );
}

function extractFirstUsdPrice(text: string): number | null {
  const match = text.match(/\$\s*(\d{1,6}(?:\.\d{1,2})?)/);

  if (!match?.[1]) return null;

  const price = Number(match[1]);

  return Number.isFinite(price) && price > 0 ? price : null;
}

function extractRawLabels(text: string): Record<string, string> {
  const labels = [
    "Ungraded Price",
    "Graded Price",
    "Comic Book",
    "Series",
    "Issue",
    "Publisher",
    "Release Date",
    "PriceCharting ID"
  ];

  const result: Record<string, string> = {};

  for (const label of labels) {
    const escaped = escapeRegExp(label);
    const pattern = new RegExp(`${escaped}\\s*([^\\n]{0,100})`, "i");
    const match = text.match(pattern);

    if (match?.[1]) {
      const value = match[1].trim();

      if (isSafeDetailValue(value)) {
        result[label] = value;
      }
    }
  }

  return result;
}

function choosePriceBasis(item: Item): "ungraded" | "graded" {
  const condition = normalizeText(item.condition ?? "");
  const notes = normalizeText(item.notes ?? "");
  const context = `${condition} ${notes}`;

  if (
    context.includes("graded") ||
    context.includes("cgc") ||
    context.includes("cbcs") ||
    context.includes("psa") ||
    context.includes("slab")
  ) {
    return "graded";
  }

  return "ungraded";
}

function chooseMarketPrice(
  prices: {
    ungraded: number | null;
    graded: number | null;
  },
  basis: "ungraded" | "graded"
): number | null {
  if (basis === "graded") {
    return prices.graded ?? prices.ungraded ?? null;
  }

  return prices.ungraded ?? prices.graded ?? null;
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
  if (normalizedTitle.includes(wanted)) score += 0.65;

  const wantedTokens = getImportantTokens(wanted);
  const matchedTokens = wantedTokens.filter(
    (token) =>
      normalizedTitle.includes(token) ||
      normalizedUrl.includes(token) ||
      normalizedConsole.includes(token)
  );

  if (wantedTokens.length > 0) {
    score += (matchedTokens.length / wantedTokens.length) * 0.9;
  }

  const wantedIssue = extractIssueNumber(item.name);
  const candidateIssue = extractIssueNumber(`${title} ${url}`);

  if (wantedIssue && candidateIssue) {
    if (wantedIssue === candidateIssue) {
      score += 0.45;
    } else {
      score -= 0.3;
    }
  }

  if (isComicContext(title, url, consoleName)) {
    score += 0.35;
  } else {
    score -= 0.35;
  }

  if (isClearlyNonComic(title, url, consoleName)) {
    score -= 1.1;
  }

  return Number(score.toFixed(4));
}

function computeConfidence(
  item: Item,
  query: string,
  title: string,
  consoleName: string | null,
  score: number
): number {
  const wanted = normalizeSearchText(query);
  const matched = normalizeSearchText(title);
  const wantedTokens = getImportantTokens(wanted);
  const matchedTokens = wantedTokens.filter((token) => matched.includes(token));

  let confidence = 0.42;

  confidence += Math.min(0.24, score * 0.1);

  if (matched === wanted) confidence += 0.16;
  if (matched.includes(wanted)) confidence += 0.1;

  if (wantedTokens.length > 0) {
    confidence += (matchedTokens.length / wantedTokens.length) * 0.16;
  }

  const wantedIssue = extractIssueNumber(item.name);
  const candidateIssue = extractIssueNumber(title);

  if (wantedIssue && candidateIssue && wantedIssue === candidateIssue) {
    confidence += 0.08;
  }

  if (isComicContext(title, "", consoleName)) {
    confidence += 0.08;
  }

  if (isClearlyNonComic(title, "", consoleName)) {
    confidence -= 0.3;
  }

  return Math.max(0.35, Math.min(0.93, Number(confidence.toFixed(2))));
}

function isComicContext(
  title: string,
  url: string,
  consoleName: string | null
): boolean {
  const text = normalizeSearchText(`${title} ${url} ${consoleName ?? ""}`);

  return (
    text.includes("comic") ||
    text.includes("comics") ||
    text.includes("comic books") ||
    text.includes("/comic-books/") ||
    text.includes("manga")
  );
}

function isClearlyNonComic(
  title: string,
  url: string,
  consoleName: string | null
): boolean {
  const text = normalizeSearchText(`${title} ${url} ${consoleName ?? ""}`);

  return (
    text.includes("playstation") ||
    text.includes("gamecube") ||
    text.includes("nintendo") ||
    text.includes("xbox") ||
    text.includes("funko") ||
    text.includes("pokemon card") ||
    text.includes("sports card") ||
    text.includes("strategy guide")
  );
}

function getImportantTokens(normalizedText: string): string[] {
  const stopWords = new Set([
    "the",
    "and",
    "of",
    "de",
    "la",
    "el",
    "los",
    "las",
    "comic",
    "comics",
    "manga",
    "volume",
    "vol",
    "tomo",
    "issue",
    "number",
    "numero",
    "núm",
    "num"
  ]);

  return normalizedText
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length > 1)
    .filter((token) => !stopWords.has(token));
}

function normalizeComicIssueQuery(value: string): string | null {
  const clean = String(value || "")
    .replace(/[#]/g, " ")
    .replace(/\bno\.?\b/gi, " ")
    .replace(/\bnum\.?\b/gi, " ")
    .replace(/\bnúm\.?\b/gi, " ")
    .replace(/\bissue\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return clean || null;
}

function removeTrailingIssueNumber(value: string): string | null {
  const cleaned = String(value || "")
    .replace(/\s+#?\d{1,4}\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || null;
}

function extractIssueNumber(value: string): string | null {
  const text = normalizeSearchText(value);

  const hashMatch = text.match(/#\s*(\d{1,4})/);
  if (hashMatch?.[1]) return hashMatch[1];

  const trailing = text.match(/\b(\d{1,4})$/);
  if (trailing?.[1]) return trailing[1];

  const issue = text.match(/\b(?:issue|num|numero|tomo|vol|volume)\s*(\d{1,4})\b/);
  if (issue?.[1]) return issue[1];

  return null;
}

function extractConsoleNameFromRow(text: string, url: string): string | null {
  const fromUrl = extractConsoleNameFromUrl(url);
  if (fromUrl) return fromUrl;

  const normalized = normalizeSearchText(text);

  if (normalized.includes("comic books")) return "Comic Books";
  if (normalized.includes("comic book")) return "Comic Books";
  if (normalized.includes("manga")) return "Manga";

  return null;
}

function extractConsoleNameFromTitle(title: string): string | null {
  const normalized = normalizeSearchText(title);

  if (normalized.includes("comic books")) return "Comic Books";
  if (normalized.includes("comic book")) return "Comic Books";
  if (normalized.includes("manga")) return "Manga";

  return null;
}

function extractConsoleNameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);

    const categorySlug = segments[1] ?? "";

    if (categorySlug.includes("comic")) return "Comic Books";
    if (categorySlug.includes("manga")) return "Manga";

    return categorySlug
      ? categorySlug
          .replace(/-/g, " ")
          .replace(/\b\w/g, (char) => char.toUpperCase())
          .trim()
      : null;
  } catch {
    return null;
  }
}

function cleanSafeConsoleName(value: string): string | null {
  const cleaned = cleanTitle(value);

  if (!cleaned) return null;
  if (!isSafeDetailValue(cleaned)) return null;
  if (cleaned.length > 60) return null;

  const normalized = normalizeSearchText(cleaned);

  if (
    normalized.includes("body") ||
    normalized.includes("overflow") ||
    normalized.includes("vgpc") ||
    normalized.includes("function") ||
    normalized.includes("script")
  ) {
    return null;
  }

  return cleaned;
}

function isSafeDetailValue(value: string): boolean {
  const normalized = normalizeSearchText(value);

  if (!value || value.length > 140) return false;

  return !(
    normalized.includes("function") ||
    normalized.includes("script") ||
    normalized.includes("body") ||
    normalized.includes("overflow") ||
    normalized.includes("vgpc") ||
    normalized.includes("_uid") ||
    normalized.includes("price compari") ||
    normalized.includes("pricecharting pro")
  );
}

function isComicProductUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    if (!parsed.hostname.includes("pricecharting.com")) return false;
    if (!parsed.pathname.includes("/game/")) return false;
    if (parsed.pathname.includes("/offering/")) return false;
    if (parsed.pathname.includes("/search")) return false;

    const path = parsed.pathname.toLowerCase();

    return (
      path.includes("/comic-books/") ||
      path.includes("/manga/") ||
      path.includes("/comic/")
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

    return cleanTitle(last.replace(/-/g, " ").replace(/\s+/g, " ").trim());
  } catch {
    return "";
  }
}

function normalizeSearchText(value: string): string {
  return normalizeText(value)
    .replace(/[™®©]/g, "")
    .replace(/[:_()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanQuery(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanQueryForSearch(value: string): string {
  return String(value || "")
    .replace(/[™®©]/g, "")
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

function cleanSaleTitle(value: string): string {
  const cleaned = cleanTitle(value)
    .replace(/^>+\s*/g, "")
    .replace(/\bSubscribe\b/gi, "")
    .replace(/\bBuy\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned || cleaned.length < 3) return "";

  return cleaned;
}

function normalizeWhitespace(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
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
      console.log("❌ PriceCharting Comic fetch failed:", {
        status: res.status,
        url
      });

      return null;
    }

    return await res.text();
  } catch (error) {
    console.log("❌ PriceCharting Comic fetch error:", {
      url,
      error
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}