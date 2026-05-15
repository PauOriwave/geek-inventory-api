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

const BASE_URL = "https://store.nin-nin-game.com";
const REQUEST_TIMEOUT_MS = 10000;
const DIRECT_PRODUCT_TIMEOUT_MS = 5000;

const SUPPORTED_CATEGORIES = new Set(["merch", "figure"]);

export async function getNinNinGamePrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  console.log("🎌 NinNinGame called:", {
    itemId: item.id,
    name: item.name,
    category: item.category,
    platform: item.platform
  });

  if (!SUPPORTED_CATEGORIES.has(item.category)) {
    return null;
  }

  const platform = normalizePlatform(item.platform);

  if (
    item.category === "merch" &&
    !["acrylicstand", "artprint", "apparel", "othermerch"].includes(platform)
  ) {
    return null;
  }

  const queries = buildQueries(item);

  for (const query of queries) {
    const searchUrls = buildSearchUrls(query);

    for (const searchUrl of searchUrls) {
      console.log("🎌 NinNinGame searching:", searchUrl);

      const html = await fetchHtml(searchUrl);
      if (!html) continue;

      const candidates = extractCandidates(html);

      console.log(
        "🎌 NinNinGame candidates:",
        candidates.map((candidate) => ({
          title: candidate.title,
          price: candidate.price,
          url: candidate.url
        }))
      );

      const filtered = filterCandidates(item, candidates);

      console.log(
        "🎌 NinNinGame filtered:",
        filtered.map((candidate) => ({
          title: candidate.title,
          price: candidate.price,
          url: candidate.url
        }))
      );

      const best = pickBestCandidate(item, filtered);

      if (!best) {
        console.log("🎌 NinNinGame no match:", query);
        continue;
      }

      const result = await buildResult(item, best, query);

      if (result) return result;
    }
  }

  return null;
}

function buildSearchUrls(query: string): string[] {
  const encoded = encodeURIComponent(query);

  return [
    `${BASE_URL}/en/search?controller=search&s=${encoded}`,
    `${BASE_URL}/en/search?search_query=${encoded}`
  ];
}

function buildQueries(item: Item): string[] {
  const raw = clean(item.name);
  const normalized = normalizeSearchText(raw);
  const platform = normalizePlatform(item.platform);

  const queries = new Set<string>();

  queries.add(raw);

  const withoutTypeWords = removeTypeWords(normalized);

  if (withoutTypeWords) {
    queries.add(withoutTypeWords);
  }

  if (platform === "acrylicstand") {
    queries.add(`${withoutTypeWords || raw} acrylic stand`);
    queries.add(`${withoutTypeWords || raw} acrylic`);
    queries.add(`${withoutTypeWords || raw} stand`);
    queries.add(`${withoutTypeWords || raw} acryl`);
  }

  if (platform === "artprint") {
    queries.add(`${withoutTypeWords || raw} art print`);
    queries.add(`${withoutTypeWords || raw} print`);
    queries.add(`${withoutTypeWords || raw} poster`);
  }

  if (platform === "apparel") {
    queries.add(`${withoutTypeWords || raw} t-shirt`);
    queries.add(`${withoutTypeWords || raw} shirt`);
    queries.add(`${withoutTypeWords || raw} apparel`);
  }

  const tokens = normalized.split(" ").filter(Boolean);

  if (tokens.length >= 2) {
    queries.add(tokens.slice(0, 3).join(" "));
    queries.add(tokens.slice(0, 2).join(" "));
  }

  return [...queries]
    .map((query) => query.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((query, index, arr) => arr.indexOf(query) === index)
    .slice(0, 10);
}

function extractCandidates(html: string): Candidate[] {
  const $ = cheerio.load(html);

  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  $("article, .product-miniature, .js-product-miniature, .product-container, li, div").each(
    (_, el) => {
      const root = $(el);

      const href =
        root.find("a[href]").first().attr("href") ||
        root.find("a").first().attr("href") ||
        "";

      const url = absolutize(href);

      if (!looksLikeProductUrl(url)) return;

      const title =
        root.find(".product-title").first().text().trim() ||
        root.find("h2, h3").first().text().trim() ||
        root.find("a[title]").first().attr("title")?.trim() ||
        root.find("img[alt]").first().attr("alt")?.trim() ||
        root.find("a").first().text().trim() ||
        titleFromUrl(url);

      const priceText =
        root.find(".price").first().text().trim() ||
        root.find("[class*='price']").first().text().trim() ||
        root.text();

      addCandidate({
        title,
        href: url,
        priceText,
        candidates,
        seen
      });
    }
  );

  $("a[href]").each((_, el) => {
    const link = $(el);
    const href = link.attr("href") || "";
    const url = absolutize(href);

    if (!looksLikeProductUrl(url)) return;

    const root = link.closest("article, li, div");

    const title =
      link.attr("title")?.trim() ||
      link.text().trim() ||
      link.find("img").attr("alt")?.trim() ||
      root.find("h2, h3, .product-title").first().text().trim() ||
      titleFromUrl(url);

    const priceText =
      root.find(".price").first().text().trim() ||
      root.find("[class*='price']").first().text().trim() ||
      root.text();

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
  const title = clean(input.title);

  if (!title || !url) return;
  if (!looksLikeProductUrl(url)) return;

  const key = `${normalizeText(title)}|${url}`;

  if (input.seen.has(key)) return;

  input.seen.add(key);

  input.candidates.push({
    title,
    price: parsePrice(input.priceText),
    url
  });
}

function filterCandidates(
  item: Item,
  candidates: Candidate[]
): Candidate[] {
  const wanted = normalizeSearchText(item.name);
  const tokens = getImportantTokens(wanted);

  if (tokens.length === 0) return [];

  return candidates.filter((candidate) => {
    const title = normalizeSearchText(candidate.title);

    const hasCoreTokens = tokens.every((token) => title.includes(token));
    if (!hasCoreTokens) return false;

    const platform = normalizePlatform(item.platform);

    if (platform === "acrylicstand") {
      return hasAny(title, [
        "acrylic",
        "acryl",
        "stand",
        "acrilico",
        "acrilica"
      ]);
    }

    if (platform === "artprint") {
      return hasAny(title, ["print", "poster", "art"]);
    }

    if (platform === "apparel") {
      return hasAny(title, [
        "shirt",
        "t-shirt",
        "hoodie",
        "apparel",
        "camiseta",
        "sudadera"
      ]);
    }

    return true;
  });
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
      score += 0.25;
    }

    score += getPlatformBoost(item.platform, title);

    return {
      candidate,
      score
    };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log(
    "🎌 NinNinGame top:",
    scored.slice(0, 5).map((entry) => ({
      title: entry.candidate.title,
      score: Number(entry.score.toFixed(2)),
      price: entry.candidate.price,
      url: entry.candidate.url
    }))
  );

  const best = scored[0];

  if (!best || best.score < 0.5) {
    return null;
  }

  return best.candidate;
}

async function buildResult(
  item: Item,
  candidate: Candidate,
  query: string
): Promise<ScraperSourceResult | null> {
  const detail = await fetchDetail(candidate.url);

  const finalPrice = chooseFinalPrice(
    candidate.price,
    detail?.price ?? null
  );

  if (!finalPrice || finalPrice <= 0) {
    console.log("🎌 NinNinGame matched but no usable price:", {
      title: candidate.title,
      listingPrice: candidate.price,
      detailPrice: detail?.price,
      url: candidate.url
    });

    return null;
  }

  const matchedTitle =
    detail?.title ||
    candidate.title;

  const confidence = computeConfidence(
    item,
    matchedTitle
  );

  console.log("🎌 NinNinGame selected:", {
    title: matchedTitle,
    finalPrice,
    confidence,
    url: candidate.url
  });

  return {
    price: Number(finalPrice.toFixed(2)),
    currency: "EUR",
    source: "nin_nin_game",
    confidence,
    matchedTitle,
    matchedUrl: candidate.url,
    query,
    metadata: {
      provider: "nin-nin-game",
      currency: "EUR",
      url: candidate.url,
      category: item.category,
      platform: item.platform ?? null
    }
  };
}

async function fetchDetail(
  url: string
): Promise<{ title: string | null; price: number | null } | null> {
  const html = await fetchHtml(
    url,
    DIRECT_PRODUCT_TIMEOUT_MS
  );

  if (!html) return null;

  const $ = cheerio.load(html);

  const title =
    $("h1").first().text().trim() ||
    $("meta[property='og:title']").attr("content")?.trim() ||
    $("title").text().trim() ||
    titleFromUrl(url);

  const price =
    parsePrice($(".price").first().text().trim()) ??
    parsePrice($("[class*='price']").first().text().trim()) ??
    parsePrice($("meta[property='product:price:amount']").attr("content")) ??
    extractPriceFromJson(html);

  return {
    title,
    price
  };
}

async function fetchHtml(
  url: string,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<string | null> {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs
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
        "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
        Referer: BASE_URL
      }
    });

    if (!res.ok) {
      console.log(
        "❌ NinNinGame fetch failed:",
        res.status,
        url
      );

      return null;
    }

    return await res.text();
  } catch (error) {
    console.log("❌ NinNinGame fetch error:", {
      url,
      error
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function chooseFinalPrice(
  listingPrice: number | null,
  detailPrice: number | null
): number | null {
  if (listingPrice == null || listingPrice <= 0) {
    return detailPrice && detailPrice > 0 ? detailPrice : null;
  }

  if (!detailPrice || detailPrice <= 0) {
    return listingPrice;
  }

  const difference = Math.abs(detailPrice - listingPrice);
  const maxAllowedDifference = listingPrice * 0.35;

  if (difference <= maxAllowedDifference) {
    return detailPrice;
  }

  console.log("🎌 NinNinGame price mismatch, keeping listing price:", {
    listingPrice,
    detailPrice,
    difference,
    maxAllowedDifference
  });

  return listingPrice;
}

function parsePrice(
  value: string | null | undefined
): number | null {
  const text = String(value || "").trim();

  if (!text) return null;

  const euro =
    text.match(/€\s?(\d{1,5}(?:[.,]\d{2})?)/i) ||
    text.match(/(\d{1,5}(?:[.,]\d{2})?)\s?€/i);

  if (euro?.[1]) {
    return parseEuroPrice(euro[1]);
  }

  return parseEuroPrice(text);
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
    .map((match) => Number(String(match[1]).replace(",", ".")))
    .filter((price) => Number.isFinite(price) && price > 0);

  return prices[0] ?? null;
}

function normalizePlatform(
  value: string | null
): string {
  const normalized = normalizeText(value || "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();

  if (!normalized) return "othermerch";

  if (
    normalized.includes("acrylic") ||
    normalized.includes("acrilico") ||
    normalized.includes("acrilica") ||
    normalized.includes("acrylicstand") ||
    normalized.includes("standacrilico")
  ) {
    return "acrylicstand";
  }

  if (
    normalized.includes("artprint") ||
    normalized.includes("print") ||
    normalized.includes("poster")
  ) {
    return "artprint";
  }

  if (
    normalized.includes("apparel") ||
    normalized.includes("ropa") ||
    normalized.includes("shirt") ||
    normalized.includes("camiseta") ||
    normalized.includes("hoodie")
  ) {
    return "apparel";
  }

  if (normalized.includes("figure") || normalized.includes("figura")) {
    return "figure";
  }

  return "othermerch";
}

function normalizeSearchText(
  value: string
): string {
  return normalizeText(value)
    .replace(/\s+/g, " ")
    .trim();
}

function getImportantTokens(
  value: string
): string[] {
  const stopWords = new Set([
    "stand",
    "acrylic",
    "acrilico",
    "acrilica",
    "figure",
    "figura",
    "art",
    "print",
    "poster",
    "shirt",
    "camiseta",
    "apparel",
    "ropa",
    "merch"
  ]);

  return value
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length > 2)
    .filter((token) => !stopWords.has(token));
}

function removeTypeWords(
  value: string
): string {
  return value
    .split(" ")
    .filter(Boolean)
    .filter(
      (token) =>
        ![
          "stand",
          "acrylic",
          "acrilico",
          "acrilica",
          "figure",
          "figura",
          "art",
          "print",
          "poster",
          "shirt",
          "camiseta",
          "apparel",
          "ropa",
          "merch"
        ].includes(token)
    )
    .join(" ")
    .trim();
}

function getPlatformBoost(
  platform: string | null,
  normalizedTitle: string
): number {
  const type = normalizePlatform(platform);

  if (
    type === "acrylicstand" &&
    hasAny(normalizedTitle, [
      "acrylic",
      "acryl",
      "stand",
      "acrilico",
      "acrilica"
    ])
  ) {
    return 0.18;
  }

  if (
    type === "artprint" &&
    hasAny(normalizedTitle, ["print", "poster", "art"])
  ) {
    return 0.16;
  }

  if (
    type === "apparel" &&
    hasAny(normalizedTitle, [
      "shirt",
      "t-shirt",
      "hoodie",
      "apparel",
      "camiseta",
      "sudadera"
    ])
  ) {
    return 0.16;
  }

  return 0;
}

function hasAny(value: string, tokens: string[]): boolean {
  return tokens.some((token) => value.includes(token));
}

function clean(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() || "";

    return last
      .replace(/\.html?$/i, "")
      .replace(/^\d+-/, "")
      .replace(/-\d+$/, "")
      .replace(/-/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function looksLikeProductUrl(url: string): boolean {
  const normalized = url.toLowerCase();

  if (!normalized.startsWith("http")) return false;
  if (!normalized.includes("store.nin-nin-game.com")) return false;
  if (!normalized.includes("/en/")) return false;
  if (normalized.includes("/search")) return false;
  if (normalized.includes("/cart")) return false;
  if (normalized.includes("/login")) return false;
  if (normalized.includes("/order")) return false;
  if (normalized.includes("#")) return false;

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
  const wanted = normalizeSearchText(
    item.name
  );

  const matched = normalizeSearchText(
    matchedTitle
  );

  let confidence =
    0.45 +
    similarityScore(wanted, matched) * 0.45;

  if (matched.includes(wanted)) {
    confidence += 0.08;
  }

  confidence += getPlatformBoost(item.platform, matched);

  return Math.max(
    0.3,
    Math.min(
      0.92,
      Number(confidence.toFixed(2))
    )
  );
}