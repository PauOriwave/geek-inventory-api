import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import { normalizeText, parseEuroPrice, similarityScore } from "../utils";
import { ScraperSourceResult } from "../scraper.types";

type Candidate = {
  title: string;
  price: number | null;
  url: string;
};

const BASE_URL = "https://dungeonmarvels.com";
const REQUEST_TIMEOUT_MS = 15000;

export async function getDungeonMarvelsPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (item.category !== "boardgame") return null;

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

    if (candidates.length === 0) {
      logHtmlDiagnostics(html);
      continue;
    }

    const best = pickBestCandidate(item, candidates);

    if (!best) {
      console.log("🎲 DM candidates found but no match:", query);
      continue;
    }

    const detail = await fetchDetail(best.url);
    const detailPrice = detail?.price ?? null;
    const detailTitle = detail?.title ?? null;

    const finalPrice = chooseFinalPrice(best.price, detailPrice);

    if (!finalPrice || finalPrice <= 0) {
      console.log("🎲 DM matched product but no usable price:", {
        title: best.title,
        url: best.url,
        listingPrice: best.price,
        detailPrice
      });
      continue;
    }

    const matchedTitle = detailTitle || best.title;
    const confidence = computeConfidence(item, matchedTitle);

    console.log("🎲 DM selected:", {
      title: matchedTitle,
      listingPrice: best.price,
      detailPrice,
      finalPrice,
      confidence,
      url: best.url
    });

    return {
      price: Number(finalPrice.toFixed(2)),
      source: "dungeon_marvels",
      confidence,
      matchedTitle,
      matchedUrl: best.url,
      query
    };
  }

  return null;
}

function buildSearchUrls(query: string): string[] {
  const encoded = encodeURIComponent(query);

  return [
    `${BASE_URL}/es/busqueda?controller=search&s=${encoded}`,
    `${BASE_URL}/es/buscar?controller=search&search_query=${encoded}`,
    `${BASE_URL}/es/search?controller=search&s=${encoded}`,
    `${BASE_URL}/buscar?controller=search&search_query=${encoded}`,
    `${BASE_URL}/busqueda?controller=search&s=${encoded}`,
    `${BASE_URL}/search?controller=search&s=${encoded}`
  ];
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
      console.log("❌ DM fetch failed:", res.status, url);
      return null;
    }

    return await res.text();
  } catch (err) {
    console.log("❌ DM fetch error:", err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractCandidates(html: string): Candidate[] {
  const $ = cheerio.load(html);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  extractProductCards($, candidates, seen);
  extractProductLinks($, candidates, seen);
  extractRawProductUrls(html, candidates, seen);

  return candidates;
}

function extractProductCards(
  $: cheerio.CheerioAPI,
  candidates: Candidate[],
  seen: Set<string>
) {
  const selectors = [
    ".js-product",
    ".product-miniature",
    ".product",
    ".product-item",
    ".thumbnail-container",
    "article.product-miniature",
    "article",
    "li"
  ];

  for (const selector of selectors) {
    $(selector).each((_, el) => {
      const root = $(el);

      const href =
        root.find("a[href*='.html']").first().attr("href") ||
        root.find("a[href]").first().attr("href") ||
        "";

      const url = absolutize(href);

      if (!looksLikeProductUrl(url)) return;

      const title =
        root.find(".product-title a").first().text().trim() ||
        root.find(".product-title").first().text().trim() ||
        root.find(".h3.product-title").first().text().trim() ||
        root.find("h2").first().text().trim() ||
        root.find("h3").first().text().trim() ||
        root.find("a[title]").first().attr("title")?.trim() ||
        root.find("img[alt]").first().attr("alt")?.trim() ||
        titleFromProductUrl(url);

      const priceText =
        root.find(".product-price-and-shipping .price").first().text().trim() ||
        root.find(".price").first().text().trim() ||
        root.find(".current-price").first().text().trim() ||
        root.find("[itemprop='price']").first().attr("content") ||
        root.find("[itemprop='price']").first().text().trim() ||
        root.text();

      addCandidate({
        title,
        href: url,
        priceText,
        candidates,
        seen,
        allowNullPrice: true
      });
    });
  }
}

function extractProductLinks(
  $: cheerio.CheerioAPI,
  candidates: Candidate[],
  seen: Set<string>
) {
  $("a[href]").each((_, el) => {
    const link = $(el);
    const href = link.attr("href") || "";
    const url = absolutize(href);

    if (!looksLikeProductUrl(url)) return;

    const root = link.closest("li, article, div, section");

    const title =
      link.attr("title")?.trim() ||
      link.find("img").first().attr("alt")?.trim() ||
      normalizeLinkText(link.text()) ||
      root
        .find("h1, h2, h3, .product-title, .title, img[alt]")
        .first()
        .attr("alt")
        ?.trim() ||
      root.find("h1, h2, h3, .product-title, .title").first().text().trim() ||
      titleFromProductUrl(url);

    const priceText =
      root.find(".product-price-and-shipping .price").first().text().trim() ||
      root.find(".price").first().text().trim() ||
      root.find(".current-price").first().text().trim() ||
      root.find("[itemprop='price']").first().attr("content") ||
      root.find("[itemprop='price']").first().text().trim() ||
      root.text();

    addCandidate({
      title,
      href: url,
      priceText,
      candidates,
      seen,
      allowNullPrice: true
    });
  });
}

function extractRawProductUrls(
  html: string,
  candidates: Candidate[],
  seen: Set<string>
) {
  const normalizedHtml = decodeHtml(html)
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/%2F/gi, "/");

  const patterns = [
    /https?:\/\/dungeonmarvels\.com\/[^"'<>\\\s]+\.html/gi,
    /\/[^"'<>\\\s]+\.html/gi
  ];

  for (const pattern of patterns) {
    for (const match of normalizedHtml.matchAll(pattern)) {
      const rawUrl = match[0];
      const url = absolutize(rawUrl);

      if (!looksLikeProductUrl(url)) continue;

      addCandidate({
        title: titleFromProductUrl(url),
        href: url,
        priceText: "",
        candidates,
        seen,
        allowNullPrice: true
      });
    }
  }
}

function addCandidate(input: {
  title: string;
  href: string;
  priceText: string;
  candidates: Candidate[];
  seen: Set<string>;
  allowNullPrice?: boolean;
}) {
  const url = absolutize(input.href);

  if (!looksLikeProductUrl(url)) return;

  const title = cleanTitle(input.title || titleFromProductUrl(url));
  const price = parsePrice(input.priceText);

  if (!title || !url) return;

  if ((price == null || price <= 0) && !input.allowNullPrice) return;

  const key = `${normalizeText(title)}|${price ?? "null"}|${url}`;

  if (input.seen.has(key)) return;
  input.seen.add(key);

  input.candidates.push({
    title,
    price: price != null && price > 0 ? price : null,
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
    $("meta[property='og:title']").attr("content")?.trim() ||
    $("[itemprop='name']").first().text().trim() ||
    titleFromProductUrl(url) ||
    null;

  const price =
    parsePrice($("meta[property='product:price:amount']").attr("content")) ??
    parsePrice($("meta[itemprop='price']").attr("content")) ??
    parsePrice($("[itemprop='price']").first().attr("content")) ??
    parsePrice($("[itemprop='price']").first().text().trim()) ??
    parsePrice($(".current-price .price").first().text().trim()) ??
    parsePrice($(".product-prices .price").first().text().trim()) ??
    parsePrice($(".price").first().text().trim()) ??
    extractPriceFromJson(html) ??
    null;

  console.log("🎲 DM detail parsed:", {
    url,
    title,
    price
  });

  return {
    title: title ? cleanTitle(title) : null,
    price
  };
}

function pickBestCandidate(item: Item, candidates: Candidate[]): Candidate | null {
  const wanted = normalizeSearchText(item.name);
  const importantTokens = getImportantTokens(wanted);

  console.log(
    "🎲 DM raw candidates:",
    candidates.slice(0, 12).map((candidate) => ({
      title: candidate.title,
      price: candidate.price,
      url: candidate.url
    }))
  );

  const filtered = candidates.filter((candidate) => {
    const title = normalizeSearchText(candidate.title);
    const url = normalizeSearchText(candidate.url);

    return importantTokens.every(
      (token) => title.includes(token) || url.includes(token)
    );
  });

  console.log("🎲 DM filtered candidates:", filtered.length);

  if (filtered.length === 0) return null;

  const scored = filtered.map((candidate) => {
    const title = normalizeSearchText(candidate.title);
    const url = normalizeSearchText(candidate.url);

    let score = similarityScore(wanted, title);

    if (title.includes(wanted)) score += 0.3;
    if (url.includes(wanted.replace(/\s+/g, "-"))) score += 0.2;
    if (candidate.price != null && candidate.price > 0) score += 0.05;

    return {
      candidate,
      score
    };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log(
    "🎲 DM top:",
    scored.slice(0, 8).map((s) => ({
      title: s.candidate.title,
      price: s.candidate.price,
      score: Number(s.score.toFixed(2)),
      url: s.candidate.url
    }))
  );

  const best = scored[0];

  if (!best || best.score < 0.45) return null;

  return best.candidate;
}

function chooseFinalPrice(
  listingPrice: number | null,
  detailPrice: number | null
): number | null {
  if (listingPrice == null || listingPrice <= 0) {
    return detailPrice && detailPrice > 0 ? detailPrice : null;
  }

  if (!detailPrice || detailPrice <= 0) return listingPrice;

  const difference = Math.abs(detailPrice - listingPrice);
  const maxAllowedDifference = listingPrice * 0.25;

  if (difference <= maxAllowedDifference) return detailPrice;

  return listingPrice;
}

function parsePrice(text: string | null | undefined): number | null {
  const value = String(text || "").trim();

  if (!value) return null;

  const numeric = Number(value.replace(",", "."));
  if (Number.isFinite(numeric) && numeric > 0) return numeric;

  const matches = [...value.matchAll(/(\d{1,5}(?:[.,]\d{2})?)\s*€/g)];

  if (matches.length > 0) {
    const last = matches[matches.length - 1]?.[1];
    return parseEuroPrice(last ?? null);
  }

  return parseEuroPrice(value);
}

function extractPriceFromJson(html: string): number | null {
  const matches = [
    ...html.matchAll(/"price"\s*:\s*"?(\d+(?:[.,]\d+)?)"?/g),
    ...html.matchAll(/"salePrice"\s*:\s*"?(\d+(?:[.,]\d+)?)"?/g),
    ...html.matchAll(/"finalPrice"\s*:\s*"?(\d+(?:[.,]\d+)?)"?/g)
  ];

  const prices = matches
    .map((match) => Number(String(match[1]).replace(",", ".")))
    .filter((price) => Number.isFinite(price) && price > 0 && price < 500)
    .sort((a, b) => b - a);

  return prices[0] ?? null;
}

function titleFromProductUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() || "";
    const withoutExt = last.replace(/\.html$/i, "");

    return withoutExt
      .replace(/^\d+-/, "")
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function getImportantTokens(normalizedText: string): string[] {
  const stopWords = new Set([
    "el",
    "la",
    "los",
    "las",
    "un",
    "una",
    "unos",
    "unas",
    "de",
    "del",
    "en",
    "a",
    "al",
    "y",
    "o",
    "por",
    "para",
    "con",
    "sin",
    "the"
  ]);

  return normalizedText
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length > 2)
    .filter((token) => !stopWords.has(token));
}

function normalizeSearchText(value: string): string {
  return normalizeText(value)
    .replace(/\bedicion\b/g, "")
    .replace(/\bedición\b/g, "")
    .replace(/\bcastellano\b/g, "")
    .replace(/\bespañol\b/g, "")
    .replace(/\bespanol\b/g, "")
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
    .replace(/Comprar/gi, "")
    .replace(/Añadir al carrito/gi, "")
    .replace(/Vista rápida/gi, "")
    .replace(/Oferta/gi, "")
    .replace(/Agotado/gi, "")
    .trim();
}

function normalizeLinkText(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/Comprar/gi, "")
    .replace(/Añadir al carrito/gi, "")
    .replace(/Vista rápida/gi, "")
    .trim();
}

function looksLikeProductUrl(url: string): boolean {
  const normalized = url.toLowerCase();

  if (!normalized.startsWith("http")) return false;
  if (!normalized.includes("dungeonmarvels.com")) return false;

  if (normalized.includes("/busqueda")) return false;
  if (normalized.includes("/buscar")) return false;
  if (normalized.includes("/search")) return false;
  if (normalized.includes("/carrito")) return false;
  if (normalized.includes("/login")) return false;
  if (normalized.includes("#")) return false;

  return normalized.endsWith(".html");
}

function logHtmlDiagnostics(html: string) {
  const normalizedHtml = decodeHtml(html)
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/%2F/gi, "/");

  const productUrlMatches = [
    ...(normalizedHtml.match(
      /https?:\/\/dungeonmarvels\.com\/[^"'<>\\\s]+\.html/gi
    ) ?? []),
    ...(normalizedHtml.match(/\/[^"'<>\\\s]+\.html/gi) ?? [])
  ];

  console.log("🎲 DM diagnostics:", {
    containsPriceText: normalizedHtml.includes("€"),
    containsProductMiniature: normalizedHtml.includes("product-miniature"),
    containsProductTitle: normalizedHtml.includes("product-title"),
    sampleProductUrls: productUrlMatches.slice(0, 10)
  });
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
  if (href.startsWith("/")) return `${BASE_URL}${href}`;
  return `${BASE_URL}/${href}`;
}

function computeConfidence(item: Item, matchedTitle: string): number {
  const wanted = normalizeSearchText(item.name);
  const matched = normalizeSearchText(matchedTitle);

  let confidence = 0.45 + similarityScore(wanted, matched) * 0.45;

  if (matched.includes(wanted)) confidence += 0.05;

  return Math.max(0.2, Math.min(0.92, Number(confidence.toFixed(2))));
}