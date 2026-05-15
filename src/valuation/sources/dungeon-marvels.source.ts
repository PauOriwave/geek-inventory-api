import { Item } from "@prisma/client";
import * as cheerio from "cheerio";

import {
  normalizeText,
  parseEuroPrice,
  similarityScore
} from "../utils";

import { ScraperSourceResult } from "../scraper.types";

type Candidate = {
  title: string;
  price: number | null;
  url: string;
};

const BASE_URL = "https://dungeonmarvels.com";
const REQUEST_TIMEOUT_MS = 8000;

const SUPPORTED_CATEGORIES = new Set([
  "boardgame",
  "miniature",
  "figure",
  "lego",
  "merch"
]);

export async function getDungeonMarvelsPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  console.log("🎲 DM called:", {
    itemId: item.id,
    name: item.name,
    category: item.category
  });

  if (!SUPPORTED_CATEGORIES.has(item.category)) {
    return null;
  }

  const query = cleanQuery(item.name);
  if (!query) return null;

  const searchUrls = buildSearchUrls(query);

  for (const searchUrl of searchUrls) {
    console.log("🎲 DM Searching:", searchUrl);

    const html = await fetchHtml(searchUrl);
    if (!html) continue;

    console.log("🎲 DM html length:", html.length);

    const candidates = extractCandidates(html);

    console.log("🎲 DM candidates:", candidates.length);

    const filtered = filterCandidates(item, candidates);

    console.log(
      "🎲 DM filtered candidates:",
      filtered.map((candidate) => ({
        title: candidate.title,
        price: candidate.price,
        url: candidate.url
      }))
    );

    const best = pickBestCandidate(item, filtered);

    if (!best) {
      console.log("🎲 DM candidates found but no match:", query);
      continue;
    }

    const detail = await fetchDetail(best.url);

    const finalPrice = chooseFinalPrice(
      best.price,
      detail?.price ?? null
    );

    if (!finalPrice || finalPrice <= 0) {
      continue;
    }

    const matchedTitle = detail?.title || best.title;
    const confidence = computeConfidence(item, matchedTitle);

    console.log("🎲 DM selected:", {
      title: matchedTitle,
      finalPrice,
      confidence,
      url: best.url
    });

    return {
      price: Number(finalPrice.toFixed(2)),
      currency: "EUR",
      source: "dungeon_marvels",
      confidence,
      matchedTitle,
      matchedUrl: best.url,
      query,
      metadata: {
        provider: "dungeon_marvels",
        currency: "EUR",
        category: item.category,
        platform: item.platform ?? null,
        url: best.url
      }
    };
  }

  return null;
}

function buildSearchUrls(query: string): string[] {
  const encoded = encodeURIComponent(query);

  return [
    `${BASE_URL}/es/busqueda?controller=search&s=${encoded}`,
    `${BASE_URL}/es/buscar?controller=search&search_query=${encoded}`
  ];
}

async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        Referer: BASE_URL
      }
    });

    if (!res.ok) {
      console.log("❌ DM fetch failed:", res.status, url);
      return null;
    }

    return await res.text();
  } catch (error) {
    console.log("❌ DM fetch error:", {
      url,
      error
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractCandidates(html: string): Candidate[] {
  const $ = cheerio.load(html);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  $(".product-miniature, .js-product, article").each((_, el) => {
    const root = $(el);

    const href =
      root.find("a[href*='.html']").first().attr("href") || "";

    const url = absolutize(href);

    if (!looksLikeProductUrl(url)) return;

    const title =
      root.find(".product-title").first().text().trim() ||
      root.find("h2").first().text().trim() ||
      root.find("h3").first().text().trim() ||
      titleFromProductUrl(url);

    const priceText =
      root.find(".price").first().text().trim() || "";

    addCandidate({
      title,
      href: url,
      priceText,
      candidates,
      seen
    });
  });

  return candidates;
}

function addCandidate(input: {
  title: string;
  href: string;
  priceText: string;
  candidates: Candidate[];
  seen: Set<string>;
}) {
  const url = absolutize(input.href);

  if (!looksLikeProductUrl(url)) return;

  const title = cleanTitle(input.title);
  const price = parsePrice(input.priceText);

  if (!title || !url) return;

  const key = `${normalizeText(title)}|${url}`;

  if (input.seen.has(key)) return;

  input.seen.add(key);

  input.candidates.push({
    title,
    price,
    url
  });
}

async function fetchDetail(
  url: string
): Promise<{ title: string | null; price: number | null } | null> {
  const html = await fetchHtml(url);

  if (!html) return null;

  const $ = cheerio.load(html);

  const title =
    $("h1").first().text().trim() ||
    titleFromProductUrl(url);

  const price =
    parsePrice($(".price").first().text().trim()) ??
    extractPriceFromJson(html);

  return {
    title,
    price
  };
}

function filterCandidates(
  item: Item,
  candidates: Candidate[]
): Candidate[] {
  const wanted = normalizeSearchText(item.name);
  const tokens = getImportantTokens(wanted, item.category);

  if (tokens.length === 0) return [];

  return candidates.filter((candidate) => {
    const title = normalizeSearchText(candidate.title);

    const hasCoreTokens = tokens.every((token) =>
      title.includes(token)
    );

    if (!hasCoreTokens) return false;

    if (item.category !== "merch") return true;

    return matchesMerchPlatform(item, title);
  });
}

function matchesMerchPlatform(
  item: Item,
  normalizedTitle: string
): boolean {
  const platform = normalizePlatform(item.platform);

  if (platform === "poster") {
    return hasAny(normalizedTitle, [
      "poster",
      "póster",
      "lamina",
      "lámina",
      "cuadro",
      "vidrio"
    ]);
  }

  if (platform === "keychain") {
    return hasAny(normalizedTitle, [
      "llavero",
      "keychain"
    ]);
  }

  if (platform === "mug") {
    return hasAny(normalizedTitle, [
      "taza",
      "mug"
    ]);
  }

  if (platform === "plush") {
    return hasAny(normalizedTitle, [
      "peluche",
      "plush"
    ]);
  }

  if (platform === "pin") {
    return hasAny(normalizedTitle, [
      "pin",
      "pins",
      "chapa"
    ]);
  }

  if (platform === "mousepad") {
    return hasAny(normalizedTitle, [
      "alfombrilla",
      "mousepad",
      "tapete",
      "playmat"
    ]);
  }

  if (platform === "apparel") {
    return hasAny(normalizedTitle, [
      "camiseta",
      "sudadera",
      "gorra",
      "ropa",
      "shirt",
      "hoodie",
      "cap"
    ]);
  }

  if (platform === "artprint") {
    return hasAny(normalizedTitle, [
      "poster",
      "póster",
      "lamina",
      "lámina",
      "print"
    ]);
  }

  return true;
}

function pickBestCandidate(
  item: Item,
  candidates: Candidate[]
): Candidate | null {
  if (candidates.length === 0) {
    return null;
  }

  const wanted = normalizeSearchText(item.name);

  const scored = candidates.map((candidate) => {
    const title = normalizeSearchText(candidate.title);

    let score = similarityScore(wanted, title);

    if (title.includes(wanted)) {
      score += 0.3;
    }

    if (item.category === "merch") {
      score += getMerchPlatformBoost(item, title);
    }

    return {
      candidate,
      score
    };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log(
    "🎲 DM top candidates:",
    scored.slice(0, 5).map((entry) => ({
      title: entry.candidate.title,
      price: entry.candidate.price,
      score: Number(entry.score.toFixed(2)),
      url: entry.candidate.url
    }))
  );

  const best = scored[0];

  const minimumScore =
    item.category === "merch" ? 0.38 : 0.45;

  if (!best || best.score < minimumScore) {
    return null;
  }

  return best.candidate;
}

function getMerchPlatformBoost(
  item: Item,
  normalizedTitle: string
): number {
  const platform = normalizePlatform(item.platform);

  if (
    platform === "poster" &&
    matchesMerchPlatform(item, normalizedTitle)
  ) {
    return 0.22;
  }

  if (
    platform === "keychain" &&
    matchesMerchPlatform(item, normalizedTitle)
  ) {
    return 0.18;
  }

  if (
    platform === "mug" &&
    matchesMerchPlatform(item, normalizedTitle)
  ) {
    return 0.18;
  }

  if (
    platform === "plush" &&
    matchesMerchPlatform(item, normalizedTitle)
  ) {
    return 0.18;
  }

  if (
    platform === "pin" &&
    matchesMerchPlatform(item, normalizedTitle)
  ) {
    return 0.18;
  }

  if (
    platform === "mousepad" &&
    matchesMerchPlatform(item, normalizedTitle)
  ) {
    return 0.18;
  }

  if (
    platform === "apparel" &&
    matchesMerchPlatform(item, normalizedTitle)
  ) {
    return 0.18;
  }

  return 0;
}

function chooseFinalPrice(
  listingPrice: number | null,
  detailPrice: number | null
): number | null {
  if (listingPrice == null || listingPrice <= 0) {
    return detailPrice && detailPrice > 0
      ? detailPrice
      : null;
  }

  if (!detailPrice || detailPrice <= 0) {
    return listingPrice;
  }

  const difference = Math.abs(
    detailPrice - listingPrice
  );

  const maxAllowedDifference =
    listingPrice * 0.25;

  if (difference <= maxAllowedDifference) {
    return detailPrice;
  }

  console.log(
    "🎲 DM price mismatch, keeping listing price:",
    {
      listingPrice,
      detailPrice,
      difference,
      maxAllowedDifference
    }
  );

  return listingPrice;
}

function parsePrice(
  text: string | null | undefined
): number | null {
  const value = String(text || "").trim();

  if (!value) return null;

  const numeric = Number(
    value.replace(",", ".")
  );

  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  return parseEuroPrice(value);
}

function extractPriceFromJson(
  html: string
): number | null {
  const matches = [
    ...html.matchAll(
      /"price"\s*:\s*"?(\d+(?:[.,]\d+)?)"?/g
    )
  ];

  const prices = matches
    .map((match) =>
      Number(String(match[1]).replace(",", "."))
    )
    .filter(
      (price) =>
        Number.isFinite(price) && price > 0
    );

  return prices[0] ?? null;
}

function titleFromProductUrl(url: string): string {
  try {
    const parsed = new URL(url);

    const last =
      parsed.pathname
        .split("/")
        .filter(Boolean)
        .pop() || "";

    return last
      .replace(/\.html$/i, "")
      .replace(/^\d+-/, "")
      .replace(/-\d+$/, "")
      .replace(/-/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function getImportantTokens(
  normalizedText: string,
  category: string
): string[] {
  const stopWords = new Set([
    "the",
    "and",
    "warhammer",
    "40000",
    "40k"
  ]);

  if (category === "merch") {
    [
      "poster",
      "póster",
      "keychain",
      "llavero",
      "pin",
      "mug",
      "taza",
      "plush",
      "peluche",
      "apparel",
      "ropa",
      "art",
      "print",
      "acrylic",
      "stand",
      "mousepad",
      "merch"
    ].forEach((word) =>
      stopWords.add(word)
    );
  }

  return normalizedText
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length > 2)
    .filter((token) => !stopWords.has(token));
}

function normalizePlatform(
  value: string | null
): string {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñ]+/g, "")
    .trim();

  if (!normalized) return "othermerch";

  if (normalized.includes("poster")) {
    return "poster";
  }

  if (
    normalized.includes("keychain") ||
    normalized.includes("llavero")
  ) {
    return "keychain";
  }

  if (
    normalized.includes("mug") ||
    normalized.includes("taza")
  ) {
    return "mug";
  }

  if (
    normalized.includes("plush") ||
    normalized.includes("peluche")
  ) {
    return "plush";
  }

  if (
    normalized.includes("pin") ||
    normalized.includes("chapa")
  ) {
    return "pin";
  }

  if (
    normalized.includes("mousepad") ||
    normalized.includes("alfombrilla")
  ) {
    return "mousepad";
  }

  if (
    normalized.includes("apparel") ||
    normalized.includes("ropa")
  ) {
    return "apparel";
  }

  if (normalized.includes("artprint")) {
    return "artprint";
  }

  return "othermerch";
}

function hasAny(
  value: string,
  tokens: string[]
): boolean {
  return tokens.some((token) =>
    value.includes(token)
  );
}

function normalizeSearchText(value: string): string {
  return normalizeText(value)
    .replace(/\s+/g, " ")
    .trim();
}

function cleanQuery(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTitle(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeProductUrl(url: string): boolean {
  const normalized = url.toLowerCase();

  if (!normalized.startsWith("http")) return false;
  if (!normalized.includes("dungeonmarvels.com")) {
    return false;
  }
  if (!normalized.endsWith(".html")) {
    return false;
  }

  return true;
}

function absolutize(href: string): string {
  if (!href) return "";

  if (href.startsWith("http")) {
    return href;
  }

  if (href.startsWith("/")) {
    return `${BASE_URL}${href}`;
  }

  return `${BASE_URL}/${href}`;
}

function computeConfidence(
  item: Item,
  matchedTitle: string
): number {
  const wanted = normalizeSearchText(item.name);
  const matched = normalizeSearchText(matchedTitle);

  let confidence =
    0.45 +
    similarityScore(wanted, matched) * 0.45;

  if (matched.includes(wanted)) {
    confidence += 0.05;
  }

  if (item.category === "merch") {
    confidence +=
      getMerchPlatformBoost(item, matched) * 0.5;
  }

  const cap =
    item.category === "merch" ? 0.88 : 0.92;

  return Math.max(
    0.2,
    Math.min(
      cap,
      Number(confidence.toFixed(2))
    )
  );
}