import { Item } from "@prisma/client";
import * as cheerio from "cheerio";

import { ScraperSourceResult } from "../scraper.types";
import { normalizeText, parseEuroPrice, similarityScore } from "../utils";

type DvdStoreCandidate = {
  title: string;
  url: string;
  price: number | null;
  score: number;
};

const BASE_URL = "https://dvdstorespain.es";
const REQUEST_TIMEOUT_MS = 15000;

export async function getDvdStoreSpainPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (item.category !== "movie") return null;

  const query = String(item.name || "").trim();
  if (!query) return null;

  console.log("📀 DVD Store Spain called:", {
    itemId: item.id,
    name: item.name,
    category: item.category,
    platform: item.platform,
    region: item.region
  });

  const candidates = await searchDvdStoreSpain(query);

  console.log(
    "📀 DVD Store Spain candidates:",
    candidates.slice(0, 10).map((candidate) => ({
      title: candidate.title,
      price: candidate.price,
      score: Number(candidate.score.toFixed(2)),
      url: candidate.url
    }))
  );

  const best = candidates[0];

  if (!best || best.score < 0.55) {
    console.log("📀 DVD Store Spain no match:", query);
    return null;
  }

  let finalPrice = best.price;
  let finalTitle = best.title;

  const detailHtml = await fetchHtml(best.url);
  if (detailHtml) {
    const detail = parseDetailPage(detailHtml, best.url);

    if (detail?.title) finalTitle = detail.title;
    if (detail?.price && detail.price > 0) finalPrice = detail.price;
  }

  if (!finalPrice || finalPrice <= 0) {
    return null;
  }

  const confidence = computeConfidence(query, finalTitle, best.score);

  return {
    price: Number(finalPrice.toFixed(2)),
    currency: "EUR",
    source: "dvd_store_spain",
    confidence,
    matchedTitle: finalTitle,
    matchedUrl: best.url,
    query,
    metadata: {
      provider: "dvd_store_spain",
      listingPrice: best.price,
      finalPrice,
      candidate: best,
      candidates: candidates.slice(0, 10)
    }
  };
}

async function searchDvdStoreSpain(query: string): Promise<DvdStoreCandidate[]> {
  const urls = buildSearchUrls(query);
  const allCandidates: DvdStoreCandidate[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    console.log("📀 DVD Store Spain searching:", url);

    const html = await fetchHtml(url);
    if (!html) continue;

    const candidates = extractCandidates(html, query);

    for (const candidate of candidates) {
      if (seen.has(candidate.url)) continue;

      seen.add(candidate.url);
      allCandidates.push(candidate);
    }

    if (allCandidates.length > 0) break;
  }

  return allCandidates.sort((a, b) => b.score - a.score).slice(0, 20);
}

function buildSearchUrls(query: string): string[] {
  const encoded = encodeURIComponent(query);

  return [
    `${BASE_URL}/?s=${encoded}`,
    `${BASE_URL}/es/?s=${encoded}`,
    `${BASE_URL}/buscar?controller=search&s=${encoded}`,
    `${BASE_URL}/es/buscar?controller=search&s=${encoded}`,
    `${BASE_URL}/search?controller=search&s=${encoded}`,
    `${BASE_URL}/es/search?controller=search&s=${encoded}`
  ];
}

function extractCandidates(html: string, query: string): DvdStoreCandidate[] {
  const $ = cheerio.load(html);
  const candidates: DvdStoreCandidate[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_, el) => {
    const link = $(el);
    const href = decodeHtml(link.attr("href") || "");
    const url = absolutize(href);

    if (!isProductUrl(url)) return;

    const container = link.closest(
      "article, li, .product, .product-miniature, .product-container, .ajax_block_product, .item, .thumbnail-container, div"
    );

    const rawTitle =
      cleanTitle(link.attr("title") || "") ||
      cleanTitle(link.text()) ||
      cleanTitle(container.find(".product-title, h2, h3, .name").first().text()) ||
      titleFromUrl(url);

    const title = cleanupProductTitle(rawTitle);
    if (!title || title.length < 2) return;

    const containerText = container.text().replace(/\s+/g, " ").trim();
    const price =
      extractFirstEuroPrice(containerText) ??
      extractFirstEuroPrice(link.text()) ??
      null;

    const score = scoreCandidate(query, title, url);

    if (score < 0.35) return;

    const key = url;
    if (seen.has(key)) return;
    seen.add(key);

    candidates.push({
      title,
      url,
      price,
      score
    });
  });

  extractRawProductUrls(html).forEach((url) => {
    const title = titleFromUrl(url);
    const score = scoreCandidate(query, title, url);

    if (score < 0.35) return;
    if (seen.has(url)) return;
    seen.add(url);

    candidates.push({
      title,
      url,
      price: null,
      score
    });
  });

  return candidates.sort((a, b) => b.score - a.score);
}

function parseDetailPage(
  html: string,
  url: string
): { title: string; price: number | null } | null {
  const $ = cheerio.load(html);

  const title =
    cleanTitle($("h1").first().text()) ||
    cleanTitle($("meta[property='og:title']").attr("content") || "") ||
    titleFromUrl(url);

  const price =
    extractFirstEuroPrice($("body").text()) ??
    extractPriceFromJsonLd(html) ??
    null;

  if (!title && !price) return null;

  return {
    title,
    price
  };
}

function extractPriceFromJsonLd(html: string): number | null {
  const $ = cheerio.load(html);

  let found: number | null = null;

  $("script[type='application/ld+json']").each((_, el) => {
    if (found) return;

    const raw = $(el).html() || "";
    const parsed = safeJsonParse(raw);

    found = findPriceInJson(parsed);
  });

  return found;
}

function findPriceInJson(value: unknown): number | null {
  if (value == null) return null;

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findPriceInJson(entry);
      if (found) return found;
    }

    return null;
  }

  if (typeof value !== "object") return null;

  const record = value as Record<string, unknown>;

  const directPrice =
    record.price ??
    record.lowPrice ??
    record.highPrice ??
    record.amount ??
    record.value;

  const parsedDirect = parseUnknownPrice(directPrice);
  if (parsedDirect) return parsedDirect;

  for (const nested of Object.values(record)) {
    const found = findPriceInJson(nested);
    if (found) return found;
  }

  return null;
}

function parseUnknownPrice(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  if (typeof value === "string") {
    return parseCardPrice(value);
  }

  return null;
}

function computeConfidence(query: string, title: string, score: number): number {
  let confidence = 0.45;

  const normalizedQuery = normalizeText(query);
  const normalizedTitle = normalizeText(title);

  confidence += Math.min(0.25, score * 0.12);

  if (normalizedTitle === normalizedQuery) confidence += 0.25;
  if (normalizedTitle.includes(normalizedQuery)) confidence += 0.15;

  const queryTokens = normalizedQuery
    .split(" ")
    .filter((token) => token.length > 2);

  const matchedTokens = queryTokens.filter((token) =>
    normalizedTitle.includes(token)
  );

  if (queryTokens.length > 0) {
    confidence += (matchedTokens.length / queryTokens.length) * 0.15;
  }

  return Math.max(0.45, Math.min(0.92, Number(confidence.toFixed(2))));
}

function scoreCandidate(query: string, title: string, url: string): number {
  let score = 0;

  const wanted = normalizeText(query);
  const normalizedTitle = normalizeText(title);
  const normalizedUrl = normalizeText(url).replace(/\s+/g, "-");

  score += similarityScore(wanted, normalizedTitle);

  if (normalizedTitle === wanted) score += 1;
  if (normalizedTitle.includes(wanted)) score += 0.7;
  if (normalizedUrl.includes(wanted.replace(/\s+/g, "-"))) score += 0.5;

  const wantedTokens = wanted
    .split(" ")
    .filter((token) => token.length > 2);

  const matchedTokens = wantedTokens.filter(
    (token) =>
      normalizedTitle.includes(token) ||
      normalizedUrl.includes(token)
  );

  if (wantedTokens.length > 0) {
    score += (matchedTokens.length / wantedTokens.length) * 0.8;
  }

  return Number(score.toFixed(4));
}

function extractFirstEuroPrice(text: string): number | null {
  const patterns = [
    /(\d{1,5}(?:[.,]\d{1,2})?)\s*€/,
    /€\s*(\d{1,5}(?:[.,]\d{1,2})?)/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (!match?.[1]) continue;

    const price = parseCardPrice(match[1]);
    if (price && price > 0) return price;
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

function isProductUrl(url: string): boolean {
  if (!url.startsWith(BASE_URL)) return false;

  const lowered = url.toLowerCase();

  if (
    lowered.includes("/cart") ||
    lowered.includes("/carrito") ||
    lowered.includes("/checkout") ||
    lowered.includes("/login") ||
    lowered.includes("/mi-cuenta") ||
    lowered.includes("/my-account") ||
    lowered.includes("/wishlist") ||
    lowered.includes("/category/") ||
    lowered.includes("/categoria/") ||
    lowered.includes("/tag/") ||
    lowered.includes("/blog")
  ) {
    return false;
  }

  return (
    /-\d+\.html(?:$|\?)/i.test(lowered) ||
    lowered.includes("/producto/") ||
    lowered.includes("/product/")
  );
}

function extractRawProductUrls(html: string): string[] {
  const decoded = decodeHtml(html)
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/%2F/gi, "/");

  const matches = [
    ...decoded.matchAll(/https?:\/\/dvdstorespain\.es\/[^"'<>\\\s]+/gi),
    ...decoded.matchAll(/\/[^"'<>\\\s]+-\d+\.html/gi)
  ];

  return matches
    .map((match) => absolutize(match[0]))
    .filter((url) => isProductUrl(url));
}

function cleanupProductTitle(value: string): string {
  return cleanTitle(value)
    .replace(/\s*-\s*DVD Store Spain\s*$/i, "")
    .replace(/\s*\|\s*DVD Store Spain\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() || "";

    return last
      .replace(/-\d+\.html$/i, "")
      .replace(/\.html$/i, "")
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function cleanTitle(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
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
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `${BASE_URL}${href}`;
  return `${BASE_URL}/${href}`;
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        Referer: BASE_URL
      }
    });

    if (!res.ok) {
      console.log("❌ DVD Store Spain fetch failed:", {
        status: res.status,
        url
      });

      return null;
    }

    return await res.text();
  } catch (error) {
    console.log("❌ DVD Store Spain fetch error:", {
      url,
      error
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}