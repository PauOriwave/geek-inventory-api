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

const BASE_URL = "https://www.todocoleccion.net";
const REQUEST_TIMEOUT_MS = 12000;
const DIRECT_DETAIL_TIMEOUT_MS = 6000;

const SUPPORTED_CATEGORIES = new Set([
  "guide",
  "magazine",
  "merch"
]);

export async function getTodocoleccionPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  console.log("🏺 Todocoleccion called:", {
    itemId: item.id,
    name: item.name,
    category: item.category,
    platform: item.platform,
    region: item.region
  });

  const category = normalizeCategory(item.category);

  if (!SUPPORTED_CATEGORIES.has(category)) {
    return null;
  }

  const queries = buildQueries(item);

  for (const query of queries) {
    const urls = buildSearchUrls(query);

    for (const url of urls) {
      console.log("🏺 Todocoleccion searching:", url);

      const html = await fetchHtml(url);
      if (!html) continue;

      console.log("🏺 Todocoleccion html length:", html.length);

      const candidates = extractCandidates(html);

      console.log(
        "🏺 Todocoleccion candidates:",
        candidates.slice(0, 20).map((candidate) => ({
          title: candidate.title,
          price: candidate.price,
          url: candidate.url
        }))
      );

      const filtered = filterCandidates(item, candidates);

      console.log(
        "🏺 Todocoleccion filtered:",
        filtered.map((candidate) => ({
          title: candidate.title,
          price: candidate.price,
          url: candidate.url
        }))
      );

      const best = pickBestCandidate(item, filtered);

      if (!best) {
        console.log("🏺 Todocoleccion no match:", query);
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
    `${BASE_URL}/buscador?from=top&bu=${encoded}`,
    `${BASE_URL}/s/${encoded}`
  ];
}

function buildQueries(item: Item): string[] {
  const raw = clean(item.name);
  const normalized = normalizeSearchText(raw);
  const category = normalizeCategory(item.category);
  const platform = normalizePlatform(item.platform);

  const queries = new Set<string>();

  queries.add(raw);

  if (category === "guide") {
    queries.add(`${raw} guia`);
    queries.add(`${raw} guía`);
    queries.add(`${raw} guia oficial`);
    queries.add(`${raw} guía oficial`);

    if (!normalized.includes("piggyback")) {
      queries.add(`${raw} piggyback`);
      queries.add(`${raw} guia piggyback`);
      queries.add(`${raw} guía piggyback`);
    }
  }

  if (category === "magazine") {
    queries.add(`${raw} revista`);
    queries.add(`${raw} hobby consolas`);
    queries.add(`${raw} magazine`);
  }

  if (category === "merch") {
    if (platform === "tazo") {
      queries.add(`${raw} tazo`);
      queries.add(`${raw} tazos`);
    }

    if (platform === "stack") {
      queries.add(`${raw} stack`);
      queries.add(`${raw} stacks`);
      queries.add(`${raw} imanes`);
      queries.add(`${raw} pokemon stacks`);
    }

    if (platform === "album") {
      queries.add(`${raw} album`);
      queries.add(`${raw} álbum`);
    }

    if (platform === "gachapon") {
      queries.add(`${raw} gachapon`);
      queries.add(`${raw} gashapon`);
    }
  }

  const tokens = normalized.split(" ").filter(Boolean);

  if (tokens.length >= 2) {
    queries.add(tokens.slice(0, 2).join(" "));
  }

  if (tokens.length >= 3) {
    queries.add(tokens.slice(0, 3).join(" "));
  }

  if (tokens.length >= 4) {
    queries.add(tokens.slice(0, 4).join(" "));
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

  $("article, li, .item, .product, .card, div").each((_, el) => {
    const root = $(el);

    const href =
      root.find("a[href*='/lote/']").first().attr("href") ||
      root.find("a[href*='todocoleccion.net']").first().attr("href") ||
      root.find("a[href]").first().attr("href") ||
      "";

    const url = absolutize(href);

    if (!looksLikeProductUrl(url)) return;

    const title =
      root.find("h2, h3, h4").first().text().trim() ||
      root.find("a[title]").first().attr("title")?.trim() ||
      root.find("img[alt]").first().attr("alt")?.trim() ||
      root.find("a[href]").first().text().trim() ||
      titleFromUrl(url);

    const priceText =
      root.find("[class*='price']").first().text().trim() ||
      root.find("[class*='precio']").first().text().trim() ||
      root.text();

    addCandidate({
      title,
      href: url,
      priceText,
      candidates,
      seen
    });
  });

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
      root.find("h2, h3, h4").first().text().trim() ||
      titleFromUrl(url);

    const priceText =
      root.find("[class*='price']").first().text().trim() ||
      root.find("[class*='precio']").first().text().trim() ||
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

function filterCandidates(item: Item, candidates: Candidate[]): Candidate[] {
  const wanted = normalizeSearchText(item.name);
  const tokens = getImportantTokens(wanted, item);

  if (tokens.length === 0) return [];

  return candidates.filter((candidate) => {
    const title = normalizeSearchText(candidate.title);

    const matchedTokens = tokens.filter((token) => title.includes(token));
    const ratio = matchedTokens.length / tokens.length;

    if (ratio < 0.65) return false;

    const category = normalizeCategory(item.category);
    const platform = normalizePlatform(item.platform);

    if (category === "guide") {
      return hasAny(title, [
        "guia",
        "guía",
        "guide",
        "piggyback",
        "oficial",
        "official"
      ]);
    }

    if (category === "magazine") {
      return hasAny(title, [
        "revista",
        "magazine",
        "hobby",
        "consolas",
        "nintendo",
        "playstation"
      ]);
    }

    if (category === "merch") {
      if (platform === "tazo") {
        return hasAny(title, ["tazo", "tazos"]);
      }

      if (platform === "stack") {
        return hasAny(title, ["stack", "stacks", "iman", "imán", "imanes"]);
      }

      if (platform === "album") {
        return hasAny(title, ["album", "álbum"]);
      }

      if (platform === "gachapon") {
        return hasAny(title, ["gachapon", "gashapon"]);
      }
    }

    return true;
  });
}

function pickBestCandidate(item: Item, candidates: Candidate[]): Candidate | null {
  if (candidates.length === 0) return null;

  const wanted = normalizeSearchText(item.name);

  const scored = candidates.map((candidate) => {
    const title = normalizeSearchText(candidate.title);

    let score = similarityScore(wanted, title);

    if (title.includes(wanted)) {
      score += 0.25;
    }

    score += getCategoryBoost(item, title);

    if (candidate.price && candidate.price > 0) {
      score += 0.08;
    }

    const category = normalizeCategory(item.category);

    if (category === "guide") {
      if (
        hasAny(title, [
          "guia oficial",
          "guía oficial",
          "official guide",
          "piggyback",
          "guia estrategia",
          "guía estrategia",
          "guia completa",
          "guía completa",
          "guia playstation",
          "guía playstation"
        ])
      ) {
        score += 0.22;
      }

      if (
        hasAny(title, [
          "argumental",
          "novela",
          "comic",
          "cómic",
          "manga"
        ])
      ) {
        score -= 0.3;
      }

      if (
        hasAny(title, [
          "revista",
          "magazine",
          "playmania",
          "hobby consolas"
        ])
      ) {
        score -= 0.12;
      }
    }

    return {
      candidate,
      score
    };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log(
    "🏺 Todocoleccion top:",
    scored.slice(0, 5).map((entry) => ({
      title: entry.candidate.title,
      score: Number(entry.score.toFixed(2)),
      price: entry.candidate.price,
      url: entry.candidate.url
    }))
  );

  const best = scored[0];

  if (!best || best.score < 0.48) {
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

  const finalPrice =
    detail?.price && detail.price > 0
      ? detail.price
      : candidate.price;

  if (!finalPrice || finalPrice <= 0) {
    console.log("🏺 Todocoleccion matched but no usable price:", {
      title: candidate.title,
      url: candidate.url,
      listingPrice: candidate.price,
      detailPrice: detail?.price
    });

    return null;
  }

  const matchedTitle =
    detail?.title ||
    candidate.title;

  const confidence = computeConfidence(item, matchedTitle);

  console.log("🏺 Todocoleccion selected:", {
    title: matchedTitle,
    finalPrice,
    confidence,
    url: candidate.url
  });

  return {
    price: Number(finalPrice.toFixed(2)),
    currency: "EUR",
    source: "todocoleccion",
    confidence,
    matchedTitle,
    matchedUrl: candidate.url,
    query,
    metadata: {
      provider: "todocoleccion",
      currency: "EUR",
      url: candidate.url,
      category: item.category,
      platform: item.platform ?? null,
      region: item.region ?? null
    }
  };
}

async function fetchDetail(
  url: string
): Promise<{ title: string | null; price: number | null } | null> {
  const html = await fetchHtml(url, DIRECT_DETAIL_TIMEOUT_MS);
  if (!html) return null;

  const $ = cheerio.load(html);

  const title =
    $("h1").first().text().trim() ||
    $("meta[property='og:title']").attr("content")?.trim() ||
    $("title").text().trim() ||
    titleFromUrl(url);

  const price =
    parsePrice($("[class*='price']").first().text().trim()) ??
    parsePrice($("[class*='precio']").first().text().trim()) ??
    parsePrice($("meta[property='product:price:amount']").attr("content")) ??
    extractPriceFromJson(html) ??
    parsePrice($("body").text());

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
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
      console.log("❌ Todocoleccion fetch failed:", res.status, url);
      return null;
    }

    return await res.text();
  } catch (error) {
    console.log("❌ Todocoleccion fetch error:", {
      url,
      error
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parsePrice(value: string | null | undefined): number | null {
  const text = String(value || "").trim();

  if (!text) return null;

  const euroMatches = [
    ...text.matchAll(/(\d{1,5}(?:[.,]\d{1,2})?)\s*€/g)
  ];

  if (euroMatches.length > 0) {
    return parseEuroPrice(euroMatches[0][1]);
  }

  const labelMatch =
    text.match(/precio\s*:?\s*(\d{1,5}(?:[.,]\d{1,2})?)/i) ||
    text.match(/venta\s*:?\s*(\d{1,5}(?:[.,]\d{1,2})?)/i);

  if (labelMatch?.[1]) {
    return parseEuroPrice(labelMatch[1]);
  }

  return null;
}

function extractPriceFromJson(html: string): number | null {
  const matches = [
    ...html.matchAll(/"price"\s*:\s*"?(\d+(?:[.,]\d+)?)"?/g)
  ];

  const prices = matches
    .map((match) => Number(String(match[1]).replace(",", ".")))
    .filter((price) => Number.isFinite(price) && price > 0);

  return prices[0] ?? null;
}

function getImportantTokens(
  normalizedText: string,
  item: Item
): string[] {
  const stopWords = new Set([
    "the",
    "and",
    "para",
    "con",
    "del",
    "los",
    "las",
    "una",
    "uno",
    "oficial",
    "official",
    "guia",
    "guía",
    "guide",
    "revista",
    "magazine"
  ]);

  const platformWords = getPlatformWords(item.platform);

  for (const word of platformWords) {
    stopWords.add(word);
  }

  return normalizedText
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length > 1)
    .filter((token) => !stopWords.has(token));
}

function getCategoryBoost(item: Item, normalizedTitle: string): number {
  const category = normalizeCategory(item.category);
  const platform = normalizePlatform(item.platform);

  if (
    category === "guide" &&
    hasAny(normalizedTitle, ["guia", "guía", "guide", "piggyback", "oficial"])
  ) {
    return 0.22;
  }

  if (
    category === "magazine" &&
    hasAny(normalizedTitle, ["revista", "magazine", "hobby", "consolas"])
  ) {
    return 0.22;
  }

  if (category === "merch") {
    if (platform === "tazo" && hasAny(normalizedTitle, ["tazo", "tazos"])) {
      return 0.22;
    }

    if (
      platform === "stack" &&
      hasAny(normalizedTitle, ["stack", "stacks", "iman", "imán", "imanes"])
    ) {
      return 0.22;
    }

    if (platform === "album" && hasAny(normalizedTitle, ["album", "álbum"])) {
      return 0.18;
    }

    if (
      platform === "gachapon" &&
      hasAny(normalizedTitle, ["gachapon", "gashapon"])
    ) {
      return 0.18;
    }
  }

  return 0;
}

function computeConfidence(item: Item, matchedTitle: string): number {
  const wanted = normalizeSearchText(item.name);
  const matched = normalizeSearchText(matchedTitle);

  let confidence = 0.42 + similarityScore(wanted, matched) * 0.44;

  if (matched.includes(wanted)) {
    confidence += 0.08;
  }

  confidence += getCategoryBoost(item, matched);

  return Math.max(
    0.25,
    Math.min(
      0.92,
      Number(confidence.toFixed(2))
    )
  );
}

function normalizeCategory(value: string | null): string {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();

  if (!normalized) return "merch";
  if (normalized === "other") return "merch";

  return normalized;
}

function normalizePlatform(value: string | null): string {
  const normalized = normalizeText(value || "")
    .replace(/\s+/g, "")
    .trim();

  if (!normalized) return "";

  if (normalized.includes("tazo")) return "tazo";
  if (normalized.includes("stack")) return "stack";
  if (normalized.includes("iman") || normalized.includes("imán")) return "stack";
  if (normalized.includes("album") || normalized.includes("álbum")) return "album";
  if (normalized.includes("gachapon") || normalized.includes("gashapon")) return "gachapon";
  if (normalized.includes("guide") || normalized.includes("guia") || normalized.includes("guía")) return "guide";
  if (normalized.includes("magazine") || normalized.includes("revista")) return "magazine";

  return normalized;
}

function getPlatformWords(platform: string | null): string[] {
  const type = normalizePlatform(platform);

  const words: Record<string, string[]> = {
    tazo: ["tazo", "tazos"],
    stack: ["stack", "stacks", "iman", "imán", "imanes"],
    album: ["album", "álbum"],
    gachapon: ["gachapon", "gashapon"],
    guide: ["guide", "guia", "guía", "oficial", "official"],
    magazine: ["magazine", "revista"]
  };

  return words[type] ?? [];
}

function hasAny(value: string, tokens: string[]): boolean {
  return tokens.some((token) => value.includes(token));
}

function looksLikeProductUrl(url: string): boolean {
  const normalized = url.toLowerCase();

  if (!normalized.startsWith("http")) return false;
  if (!normalized.includes("todocoleccion.net")) return false;

  if (normalized.includes("/buscador")) return false;
  if (normalized.includes("/s/")) return false;
  if (normalized.includes("/ayuda")) return false;
  if (normalized.includes("/login")) return false;
  if (normalized.includes("/carrito")) return false;

  return (
    normalized.includes("/lote/") ||
    normalized.includes("~x")
  );
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "";

    return decodeURIComponent(last)
      .replace(/\.htm(l)?$/i, "")
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function normalizeSearchText(value: string): string {
  return normalizeText(value)
    .replace(/\s+/g, " ")
    .trim();
}

function clean(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function absolutize(href: string): string {
  if (!href) return "";

  if (href.startsWith("http")) {
    return href;
  }

  if (href.startsWith("//")) {
    return `https:${href}`;
  }

  if (href.startsWith("/")) {
    return `${BASE_URL}${href}`;
  }

  return `${BASE_URL}/${href}`;
}