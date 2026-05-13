import { Item } from "@prisma/client";
import * as cheerio from "cheerio";

import { ScraperSourceResult } from "../scraper.types";
import { normalizeText, similarityScore } from "../utils";

type PriceChartingGameCandidate = {
  title: string;
  url: string;
  consoleName: string | null;
  loosePrice: number | null;
  completePrice: number | null;
  newPrice: number | null;
  gradedPrice: number | null;
  score: number;
};

type DetailResult = {
  title: string | null;
  consoleName: string | null;
  prices: {
    loose: number | null;
    complete: number | null;
    new: number | null;
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

export async function getPriceChartingVideogamePrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (item.category !== "videogame") return null;

  const query = cleanQuery(item.name);
  if (!query) return null;

  console.log("🎮 PriceCharting Videogame called:", {
    itemId: item.id,
    name: item.name,
    category: item.category,
    platform: item.platform,
    region: item.region,
    completeness: item.completeness,
    condition: item.condition,
    notes: item.notes
  });

  const candidates = await searchPriceCharting(item, query);

  console.log(
    "🎮 PriceCharting Videogame candidates:",
    candidates.slice(0, 10).map((candidate) => ({
      title: candidate.title,
      consoleName: candidate.consoleName,
      loosePrice: candidate.loosePrice,
      completePrice: candidate.completePrice,
      newPrice: candidate.newPrice,
      gradedPrice: candidate.gradedPrice,
      score: Number(candidate.score.toFixed(2)),
      url: candidate.url
    }))
  );

  const best = candidates[0];

  if (!best || best.score < 0.62) {
    console.log("🎮 PriceCharting Videogame no match:", query);
    return null;
  }

  const detail = await fetchDetail(best.url);

  const title = detail?.title || best.title;
  const consoleName = detail?.consoleName || best.consoleName;

  const prices = {
    loose: detail?.prices.loose ?? best.loosePrice,
    complete: detail?.prices.complete ?? best.completePrice,
    new: detail?.prices.new ?? best.newPrice,
    graded: detail?.prices.graded ?? best.gradedPrice
  };

  const priceBasis = choosePriceBasis(item);
  const finalPrice = chooseMarketPrice(prices, priceBasis);

  if (!finalPrice || finalPrice <= 0) {
    console.log("🎮 PriceCharting Videogame matched but no usable price:", {
      title,
      consoleName,
      url: best.url,
      prices,
      priceBasis
    });

    return null;
  }

  const confidence = computeConfidence(
    item,
    query,
    title,
    consoleName,
    best.score
  );

  return {
    price: Number(finalPrice.toFixed(2)),
    currency: "USD",
    source: "pricecharting_videogame",
    confidence,
    matchedTitle: title,
    matchedUrl: best.url,
    query,
    metadata: {
      provider: "pricecharting_videogame",
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
        platform: item.platform ?? null,
        normalizedPlatform: normalizePlatform(item.platform),
        region: item.region ?? null,
        normalizedRegion: normalizeRegion(item.region),
        completeness: item.completeness ?? null,
        normalizedCompleteness: normalizeCompleteness(item.completeness),
        condition: item.condition ?? null
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
): Promise<PriceChartingGameCandidate[]> {
  const queries = buildSearchQueries(item, query);
  const allCandidates: PriceChartingGameCandidate[] = [];
  const seen = new Set<string>();

  for (const searchQuery of queries) {
    const url = `${BASE_URL}/search-products?q=${encodeURIComponent(
      searchQuery
    )}&type=prices`;

    console.log("🎮 PriceCharting Videogame searching:", url);

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

function buildSearchQueries(item: Item, query: string): string[] {
  const clean = cleanQueryForSearch(query);
  const inferredPlatform = inferPlatformFromName(clean);
  const platform = normalizePlatform(item.platform) ?? inferredPlatform;
  const region = normalizeRegion(item.region);

  const queryWithoutPlatform = removePlatformTokens(clean);
  const baseQuery = queryWithoutPlatform || clean;

  const queries = new Set<string>();

  queries.add(clean);

  if (platform && region === "pal") {
    queries.add(`${baseQuery} PAL ${platform}`);
    queries.add(`${baseQuery} PAL`);
  }

  if (platform) {
    queries.add(`${baseQuery} ${platform}`);
  }

  queries.add(baseQuery);

  return [...queries]
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 6);
}

function extractSearchCandidates(
  html: string,
  item: Item,
  query: string
): PriceChartingGameCandidate[] {
  const $ = cheerio.load(html);
  const candidates: PriceChartingGameCandidate[] = [];
  const seen = new Set<string>();

  $("tr").each((_, row) => {
    const root = $(row);

    const href = root.find("a[href*='/game/']").first().attr("href") || "";
    const url = absolutize(href);

    if (!isGameProductUrl(url)) return;

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
      loosePrice: prices.loose,
      completePrice: prices.complete,
      newPrice: prices.new,
      gradedPrice: prices.graded,
      score
    });
  });

  $("a[href*='/game/']").each((_, link) => {
    const href = $(link).attr("href") || "";
    const url = absolutize(href);

    if (!isGameProductUrl(url)) return;

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
      loosePrice: prices.loose,
      completePrice: prices.complete,
      newPrice: prices.new,
      gradedPrice: prices.graded,
      score
    });
  });

  return candidates.sort((a, b) => b.score - a.score);
}

function addCandidate(
  candidates: PriceChartingGameCandidate[],
  seen: Set<string>,
  candidate: PriceChartingGameCandidate
) {
  const url = normalizeCandidateUrl(candidate.url);

  if (!isGameProductUrl(url)) return;
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

  console.log("🎮 PriceCharting Videogame detail parsed:", {
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
  complete: number | null;
  new: number | null;
  graded: number | null;
} {
  const combined = normalizeWhitespace(
    `${$("table, .price, #full-prices, #price_data, body").text()} ${bodyText}`
  );

  const loose =
    extractPriceAfterLabels(combined, ["Loose Price", "Loose", "Loose Value"]) ??
    null;

  const complete =
    extractPriceAfterLabels(combined, [
      "Complete Price",
      "CIB Price",
      "Complete",
      "In Box"
    ]) ?? null;

  const newPrice =
    extractPriceAfterLabels(combined, ["New Price", "New", "Sealed"]) ?? null;

  const graded =
    extractPriceAfterLabels(combined, [
      "Graded Price",
      "Graded",
      "New/Graded"
    ]) ?? null;

  return {
    loose,
    complete,
    new: newPrice,
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
  loose: number | null;
  complete: number | null;
  new: number | null;
  graded: number | null;
} {
  const prices = [...text.matchAll(/\$\s*(\d{1,6}(?:\.\d{1,2})?)/g)]
    .map((match) => Number(match[1]))
    .filter((price) => Number.isFinite(price) && price > 0 && price < 100000);

  return {
    loose: prices[0] ?? null,
    complete: prices[1] ?? null,
    new: prices[2] ?? null,
    graded: prices[3] ?? null
  };
}

function extractDetails(
  $: cheerio.CheerioAPI,
  url: string
): Record<string, string | number | null> {
  const details: Record<string, string | number | null> = {};
  const bodyText = normalizeWhitespace($("body").text());

  const knownLabels = [
    "Console",
    "Genre",
    "Release Date",
    "Publisher",
    "Developer",
    "UPC",
    "ASIN",
    "ePID",
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
  const consoleFromPage = cleanSafeConsoleName(String(details.console ?? ""));

  details.consoleName = consoleFromTitle || consoleFromUrl || consoleFromPage;

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
    "Loose Price",
    "Complete Price",
    "New Price",
    "Graded Price",
    "Console",
    "Genre",
    "Release Date",
    "Publisher",
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

function choosePriceBasis(item: Item): "loose" | "complete" | "new" | "graded" {
  const completeness = normalizeCompleteness(item.completeness);
  const condition = normalizeText(item.condition ?? "");
  const notes = normalizeText(item.notes ?? "");

  const context = `${completeness} ${condition} ${notes}`;

  if (
    context.includes("graded") ||
    context.includes("vga") ||
    context.includes("wata")
  ) {
    return "graded";
  }

  if (
    context.includes("sealed") ||
    context.includes("precintado") ||
    context.includes("new") ||
    context.includes("nuevo")
  ) {
    return "new";
  }

  if (
    context.includes("loose") ||
    context.includes("cart") ||
    context.includes("disc only") ||
    context.includes("cart only") ||
    context.includes("solo disco") ||
    context.includes("solo cartucho")
  ) {
    return "loose";
  }

  return "complete";
}

function chooseMarketPrice(
  prices: {
    loose: number | null;
    complete: number | null;
    new: number | null;
    graded: number | null;
  },
  basis: "loose" | "complete" | "new" | "graded"
): number | null {
  if (basis === "graded") {
    return prices.graded ?? prices.new ?? prices.complete ?? prices.loose ?? null;
  }

  if (basis === "new") {
    return prices.new ?? prices.complete ?? prices.loose ?? null;
  }

  if (basis === "loose") {
    return prices.loose ?? prices.complete ?? prices.new ?? null;
  }

  return prices.complete ?? prices.loose ?? prices.new ?? null;
}

function scoreCandidate(
  item: Item,
  query: string,
  title: string,
  url: string,
  consoleName: string | null
): number {
  const wanted = normalizeSearchText(removePlatformTokens(query));
  const normalizedTitle = normalizeSearchText(title);
  const normalizedUrl = normalizeSearchText(url);
  const normalizedConsole = normalizeSearchText(consoleName ?? "");
  const itemPlatform =
    normalizePlatform(item.platform) ?? inferPlatformFromName(item.name);
  const region = normalizeRegion(item.region);

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

  if (itemPlatform) {
    if (matchesKnownPlatformAlias(itemPlatform, normalizedConsole, normalizedUrl)) {
      score += 0.45;
    } else {
      score -= 0.35;
    }
  }

  if (region === "pal") {
    if (normalizedConsole.includes("pal") || normalizedUrl.includes("/pal-")) {
      score += 0.45;
    } else {
      score -= 0.2;
    }
  }

  if (normalizedUrl.includes("/game/")) score += 0.15;

  return Number(score.toFixed(4));
}

function computeConfidence(
  item: Item,
  query: string,
  title: string,
  consoleName: string | null,
  score: number
): number {
  const wanted = normalizeSearchText(removePlatformTokens(query));
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

  const platform =
    normalizePlatform(item.platform) ?? inferPlatformFromName(item.name);
  const consoleText = normalizeSearchText(consoleName ?? "");

  if (platform && matchesKnownPlatformAlias(platform, consoleText, "")) {
    confidence += 0.1;
  }

  if (normalizeRegion(item.region) === "pal") {
    if (consoleText.includes("pal")) confidence += 0.08;
  }

  return Math.max(0.35, Math.min(0.93, Number(confidence.toFixed(2))));
}

function getImportantTokens(normalizedText: string): string[] {
  const stopWords = new Set([
    "the",
    "and",
    "of",
    "edition",
    "standard",
    "game",
    "videojuego",
    "ps5",
    "ps4",
    "ps3",
    "ps2",
    "ps1",
    "xbox",
    "switch",
    "nintendo",
    "playstation",
    "pal",
    "ntsc"
  ]);

  return normalizedText
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length > 1)
    .filter((token) => !stopWords.has(token));
}

function normalizePlatform(value: string | null): string | null {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();

  if (!normalized) return null;

  if (
    normalized === "ps5" ||
    normalized === "playstation5" ||
    normalized === "play5"
  ) {
    return "playstation 5";
  }

  if (
    normalized === "ps4" ||
    normalized === "playstation4" ||
    normalized === "play4"
  ) {
    return "playstation 4";
  }

  if (
    normalized === "ps3" ||
    normalized === "playstation3" ||
    normalized === "play3"
  ) {
    return "playstation 3";
  }

  if (
    normalized === "ps2" ||
    normalized === "playstation2" ||
    normalized === "play2"
  ) {
    return "playstation 2";
  }

  if (
    normalized === "ps1" ||
    normalized === "psx" ||
    normalized === "playstation" ||
    normalized === "playstation1"
  ) {
    return "playstation";
  }

  if (normalized === "switch" || normalized === "nintendoswitch") {
    return "nintendo switch";
  }

  if (
    normalized === "xboxseriesx" ||
    normalized === "xboxseriess" ||
    normalized === "xboxseriesxs" ||
    normalized === "xsx"
  ) {
    return "xbox series x";
  }

  if (normalized === "xboxone" || normalized === "xone") {
    return "xbox one";
  }

  if (normalized === "gba" || normalized === "gameboyadvance") {
    return "gameboy advance";
  }

  if (normalized === "gb" || normalized === "gameboy") {
    return "gameboy";
  }

  if (normalized === "gbc" || normalized === "gameboycolor") {
    return "gameboy color";
  }

  if (
    normalized === "gc" ||
    normalized === "gcn" ||
    normalized === "gamecube" ||
    normalized === "nintendogamecube"
  ) {
    return "gamecube";
  }

  if (normalized === "3ds" || normalized === "nintendo3ds") {
    return "nintendo 3ds";
  }

  if (normalized === "ds" || normalized === "nintendods") {
    return "nintendo ds";
  }

  if (normalized === "wiiu") return "wii u";
  if (normalized === "wii") return "wii";

  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function inferPlatformFromName(value: string): string | null {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  const checks: Array<[RegExp, string]> = [
    [/\bps5\b|\bplaystation 5\b/, "playstation 5"],
    [/\bps4\b|\bplaystation 4\b/, "playstation 4"],
    [/\bps3\b|\bplaystation 3\b/, "playstation 3"],
    [/\bps2\b|\bplaystation 2\b/, "playstation 2"],
    [/\bps1\b|\bpsx\b|\bplaystation 1\b/, "playstation"],
    [/\bgamecube\b|\bgcn\b|\bgc\b/, "gamecube"],
    [/\bnintendo switch\b|\bswitch\b/, "nintendo switch"],
    [/\bxbox series\b|\bseries x\b|\bseries s\b/, "xbox series x"],
    [/\bxbox one\b/, "xbox one"],
    [/\bgba\b|\bgameboy advance\b/, "gameboy advance"],
    [/\bgbc\b|\bgameboy color\b/, "gameboy color"],
    [/\bgameboy\b|\bgb\b/, "gameboy"],
    [/\b3ds\b|\bnintendo 3ds\b/, "nintendo 3ds"],
    [/\bds\b|\bnintendo ds\b/, "nintendo ds"],
    [/\bwii u\b|\bwiiu\b/, "wii u"],
    [/\bwii\b/, "wii"]
  ];

  for (const [pattern, platform] of checks) {
    if (pattern.test(normalized)) return platform;
  }

  return null;
}

function removePlatformTokens(value: string): string {
  return String(value || "")
    .replace(/\bps5\b/gi, "")
    .replace(/\bps4\b/gi, "")
    .replace(/\bps3\b/gi, "")
    .replace(/\bps2\b/gi, "")
    .replace(/\bps1\b/gi, "")
    .replace(/\bpsx\b/gi, "")
    .replace(/\bplaystation\s*[1-5]?\b/gi, "")
    .replace(/\bgamecube\b/gi, "")
    .replace(/\bgcn\b/gi, "")
    .replace(/\bgc\b/gi, "")
    .replace(/\bnintendo\s*switch\b/gi, "")
    .replace(/\bswitch\b/gi, "")
    .replace(/\bxbox\s*series\s*x\/?s?\b/gi, "")
    .replace(/\bxbox\s*one\b/gi, "")
    .replace(/\bgameboy\s*advance\b/gi, "")
    .replace(/\bgba\b/gi, "")
    .replace(/\bgameboy\s*color\b/gi, "")
    .replace(/\bgbc\b/gi, "")
    .replace(/\bgameboy\b/gi, "")
    .replace(/\b3ds\b/gi, "")
    .replace(/\bnintendo\s*3ds\b/gi, "")
    .replace(/\bnintendo\s*ds\b/gi, "")
    .replace(/\bds\b/gi, "")
    .replace(/\bwii\s*u\b/gi, "")
    .replace(/\bwiiu\b/gi, "")
    .replace(/\bwii\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRegion(value: string | null): string | null {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();

  if (!normalized) return null;

  if (
    normalized === "pal" ||
    normalized === "eu" ||
    normalized === "eur" ||
    normalized === "europe" ||
    normalized === "european"
  ) {
    return "pal";
  }

  if (
    normalized === "ntsc" ||
    normalized === "ntscu" ||
    normalized === "usa" ||
    normalized === "us" ||
    normalized === "na"
  ) {
    return "ntsc-u";
  }

  if (
    normalized === "ntscj" ||
    normalized === "japan" ||
    normalized === "jp" ||
    normalized === "jpn"
  ) {
    return "ntsc-j";
  }

  return normalized;
}

function normalizeCompleteness(value: string | null): string {
  return normalizeText(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesKnownPlatformAlias(
  platform: string,
  consoleText: string,
  urlText: string
): boolean {
  const normalizedPlatform = normalizeSearchText(platform);
  const normalizedConsole = normalizeSearchText(consoleText);
  const normalizedUrl = normalizeSearchText(urlText);

  const haystack = `${normalizedConsole} ${normalizedUrl}`;

  if (haystack.includes(normalizedPlatform)) return true;

  const aliases = getPlatformAliases(platform);

  return aliases.some((alias) => haystack.includes(normalizeSearchText(alias)));
}

function getPlatformAliases(platform: string): string[] {
  const normalized = normalizePlatform(platform) ?? platform;

  if (normalized === "playstation 5") {
    return ["ps5", "playstation 5", "pal playstation 5"];
  }

  if (normalized === "playstation 4") {
    return ["ps4", "playstation 4", "pal playstation 4"];
  }

  if (normalized === "playstation 3") {
    return ["ps3", "playstation 3", "pal playstation 3"];
  }

  if (normalized === "playstation 2") {
    return ["ps2", "playstation 2", "pal playstation 2"];
  }

  if (normalized === "playstation") {
    return ["ps1", "psx", "playstation", "pal playstation"];
  }

  if (normalized === "nintendo switch") {
    return ["switch", "nintendo switch"];
  }

  if (normalized === "xbox series x") {
    return ["xbox series x", "xbox series x/s", "xbox series"];
  }

  if (normalized === "xbox one") {
    return ["xbox one"];
  }

  if (normalized === "gameboy advance") {
    return ["gba", "gameboy advance"];
  }

  if (normalized === "gameboy") return ["gameboy"];
  if (normalized === "gameboy color") return ["gbc", "gameboy color"];
  if (normalized === "gamecube") return ["gamecube", "nintendo gamecube"];
  if (normalized === "nintendo 3ds") return ["3ds", "nintendo 3ds"];
  if (normalized === "nintendo ds") return ["ds", "nintendo ds"];

  return [normalized];
}

function extractConsoleNameFromRow(text: string, url: string): string | null {
  const fromUrl = extractConsoleNameFromUrl(url);
  if (fromUrl) return fromUrl;

  const known = [
    "PAL Playstation 5",
    "Playstation 5",
    "PAL Playstation 4",
    "Playstation 4",
    "PAL Playstation 3",
    "Playstation 3",
    "PAL Playstation 2",
    "Playstation 2",
    "PAL Playstation",
    "Playstation",
    "Nintendo Switch",
    "Xbox Series X",
    "Xbox One",
    "PAL Gamecube",
    "JP Gamecube",
    "Gamecube",
    "GameBoy Advance",
    "GameBoy Color",
    "GameBoy",
    "GameCube",
    "Nintendo 3DS",
    "Nintendo DS",
    "Wii U",
    "Wii"
  ];

  const normalized = normalizeSearchText(text);

  for (const candidate of known) {
    if (normalized.includes(normalizeSearchText(candidate))) {
      return candidate;
    }
  }

  return null;
}

function extractConsoleNameFromTitle(title: string): string | null {
  const cleaned = cleanTitle(title);
  const known = [
    "PAL Playstation 5",
    "Playstation 5",
    "PAL Playstation 4",
    "Playstation 4",
    "PAL Playstation 3",
    "Playstation 3",
    "PAL Playstation 2",
    "Playstation 2",
    "PAL Playstation",
    "Playstation",
    "Nintendo Switch",
    "Xbox Series X",
    "Xbox One",
    "PAL Gamecube",
    "JP Gamecube",
    "Gamecube",
    "GameBoy Advance",
    "GameBoy Color",
    "GameBoy",
    "Nintendo 3DS",
    "Nintendo DS",
    "Wii U",
    "Wii"
  ];

  const normalized = normalizeSearchText(cleaned);

  for (const candidate of known) {
    if (normalized.endsWith(normalizeSearchText(candidate))) {
      return candidate;
    }
  }

  return null;
}

function extractConsoleNameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);

    if (segments.length < 2) return null;

    const consoleSlug = segments[1] ?? "";

    return consoleSlug
      .replace(/-/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase())
      .replace(/\bPal\b/g, "PAL")
      .replace(/\bJp\b/g, "JP")
      .replace(/\bPs\b/g, "PS")
      .replace(/\bGamecube\b/g, "Gamecube")
      .trim();
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

function isGameProductUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    if (!parsed.hostname.includes("pricecharting.com")) return false;
    if (!parsed.pathname.includes("/game/")) return false;
    if (parsed.pathname.includes("/offering/")) return false;
    if (parsed.pathname.includes("/search")) return false;

    return true;
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
      console.log("❌ PriceCharting Videogame fetch failed:", {
        status: res.status,
        url
      });

      return null;
    }

    return await res.text();
  } catch (error) {
    console.log("❌ PriceCharting Videogame fetch error:", {
      url,
      error
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}