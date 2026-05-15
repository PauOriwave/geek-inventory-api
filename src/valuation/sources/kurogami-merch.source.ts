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

const BASE_URL = "https://kurogami.com";
const REQUEST_TIMEOUT_MS = 10000;

const SUPPORTED_CATEGORIES = new Set(["merch"]);

const MERCH_CATEGORY_URLS: Record<string, string[]> = {
  plush: ["/es/familia/peluches"],
  mug: ["/es/familia/tazas"],
  poster: ["/es/familia/posters"],
  keychain: ["/es/familia/llaveros"],
  pin: ["/es/familia/pins"],
  mousepad: ["/es/familia/alfombrillas"],
  apparel: ["/es/familia/ropa"],
  artprint: ["/es/familia/posters"],
  acrylicstand: ["/es/familia/regalos-anime"],
  othermerch: [
    "/es/familia/regalos-anime",
    "/es/familia/regalos-videojuegos",
    "/es/familia/merchandising-kurogami"
  ]
};

export async function getKurogamiMerchPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  console.log("🧧 Kurogami called:", {
    itemId: item.id,
    name: item.name,
    category: item.category,
    platform: item.platform
  });

  if (!SUPPORTED_CATEGORIES.has(item.category)) return null;

  const queries = buildSearchQueries(item);

  for (const query of queries) {
    const resultFromDirectSlugs = await tryDirectProductSlugs(item, query);

    if (resultFromDirectSlugs) {
      return resultFromDirectSlugs;
    }

    const urls = buildSearchUrls(item, query);

    for (const url of urls) {
      console.log("🧧 Kurogami crawling:", url);

      const html = await fetchHtml(url);
      if (!html) continue;

      console.log("🧧 Kurogami html length:", html.length, "query:", query);

      const candidates = extractCandidates(html);

      console.log(
        "🧧 Kurogami candidates:",
        candidates.map((candidate) => ({
          title: candidate.title,
          price: candidate.price,
          url: candidate.url
        }))
      );

      const filtered = filterCandidates(item, candidates);

      console.log(
        "🧧 Kurogami filtered:",
        filtered.map((candidate) => ({
          title: candidate.title,
          price: candidate.price,
          url: candidate.url
        }))
      );

      const best = pickBestCandidate(item, filtered);

      if (!best) {
        console.log("🧧 Kurogami candidates found but no match:", query);
        continue;
      }

      const result = await buildResultFromCandidate(item, best, query);

      if (result) {
        return result;
      }
    }
  }

  return null;
}

async function tryDirectProductSlugs(
  item: Item,
  query: string
): Promise<ScraperSourceResult | null> {
  const urls = buildDirectProductUrls(item, query);

  for (const url of urls) {
    console.log("🧧 Kurogami direct product try:", url);

    const detail = await fetchDetail(url);

    if (!detail?.title || !detail.price || detail.price <= 0) {
      continue;
    }

    const candidate: Candidate = {
      title: detail.title,
      price: detail.price,
      url
    };

    const filtered = filterCandidates(item, [candidate]);

    if (filtered.length === 0) {
      console.log("🧧 Kurogami direct rejected:", {
        title: detail.title,
        price: detail.price,
        url
      });

      continue;
    }

    const result = await buildResultFromCandidate(item, candidate, query);

    if (result) return result;
  }

  return null;
}

function buildDirectProductUrls(item: Item, query: string): string[] {
  const platform = normalizePlatform(item.platform);
  const normalizedQuery = normalizeSearchText(query);

  const baseName = removePlatformWords(normalizedQuery, item.platform);
  const slugBase = slugify(baseName);

  const urls = new Set<string>();

  if (slugBase) {
    urls.add(`${BASE_URL}/es/producto/${slugBase}`);

    if (platform === "plush") {
      urls.add(`${BASE_URL}/es/producto/peluche-${slugBase}`);
      urls.add(`${BASE_URL}/es/producto/peluche-${slugBase}-pokemon`);
      urls.add(`${BASE_URL}/es/producto/peluche-${slugBase}-20-cms-pokemon`);
      urls.add(`${BASE_URL}/es/producto/peluche-${slugBase}-20-cm-pokemon`);
      urls.add(`${BASE_URL}/es/producto/peluche-${slugBase}-version-3-pokemon-20-cm`);
      urls.add(`${BASE_URL}/es/producto/peluche-${slugBase}-pokemon-squishmallows-50-cm`);
      urls.add(`${BASE_URL}/es/producto/peluche-${slugBase}-sonriente-pokemon-32-cm`);
    }

    if (platform === "mug") {
      urls.add(`${BASE_URL}/es/producto/taza-${slugBase}`);
      urls.add(`${BASE_URL}/es/producto/taza-${slugBase}-pokemon`);
    }

    if (platform === "keychain") {
      urls.add(`${BASE_URL}/es/producto/llavero-${slugBase}`);
      urls.add(`${BASE_URL}/es/producto/llavero-${slugBase}-pokemon`);
    }

    if (platform === "poster" || platform === "artprint") {
      urls.add(`${BASE_URL}/es/producto/poster-${slugBase}`);
      urls.add(`${BASE_URL}/es/producto/poster-${slugBase}-pokemon`);
    }

    if (platform === "mousepad") {
      urls.add(`${BASE_URL}/es/producto/alfombrilla-${slugBase}`);
      urls.add(`${BASE_URL}/es/producto/tapete-${slugBase}`);
    }

    if (platform === "pin") {
      urls.add(`${BASE_URL}/es/producto/pin-${slugBase}`);
      urls.add(`${BASE_URL}/es/producto/chapa-${slugBase}`);
    }
  }

  return [...urls];
}

async function buildResultFromCandidate(
  item: Item,
  candidate: Candidate,
  query: string
): Promise<ScraperSourceResult | null> {
  const detail = await fetchDetail(candidate.url);

  const finalPrice = chooseFinalPrice(candidate.price, detail?.price ?? null);

  if (!finalPrice || finalPrice <= 0) {
    console.log("🧧 Kurogami matched but no usable price:", {
      title: candidate.title,
      url: candidate.url,
      listingPrice: candidate.price,
      detailPrice: detail?.price
    });

    return null;
  }

  const matchedTitle = detail?.title || candidate.title;
  const confidence = computeConfidence(item, matchedTitle);

  console.log("🧧 Kurogami selected:", {
    title: matchedTitle,
    listingPrice: candidate.price,
    detailPrice: detail?.price,
    finalPrice,
    confidence,
    url: candidate.url
  });

  return {
    price: Number(finalPrice.toFixed(2)),
    currency: "EUR",
    source: "kurogami_merch",
    confidence,
    matchedTitle,
    matchedUrl: candidate.url,
    query,
    metadata: {
      provider: "kurogami",
      currency: "EUR",
      category: item.category,
      platform: item.platform ?? null,
      url: candidate.url
    }
  };
}

function buildSearchQueries(item: Item): string[] {
  const raw = cleanQuery(item.name);
  const platform = normalizePlatform(item.platform);
  const normalized = normalizeSearchText(raw);

  const queries = new Set<string>();

  queries.add(raw);

  if (platform === "plush") {
    queries.add(raw.replace(/\bplush figure\b/gi, "peluche"));
    queries.add(raw.replace(/\bplush\b/gi, "peluche"));
    queries.add(toSpanishTypeFirst(raw, ["plush", "plush figure"], "Peluche"));
  }

  if (platform === "mug") {
    queries.add(raw.replace(/\bmug\b/gi, "taza"));
    queries.add(toSpanishTypeFirst(raw, ["mug"], "Taza"));
  }

  if (platform === "keychain") {
    queries.add(raw.replace(/\bkeychain\b/gi, "llavero"));
    queries.add(toSpanishTypeFirst(raw, ["keychain"], "Llavero"));
  }

  if (platform === "mousepad") {
    queries.add(raw.replace(/\bmousepad\b/gi, "alfombrilla"));
    queries.add(toSpanishTypeFirst(raw, ["mousepad"], "Alfombrilla"));
  }

  if (platform === "poster" || platform === "artprint") {
    queries.add(raw.replace(/\bart print\b/gi, "poster"));
    queries.add(raw.replace(/\bprint\b/gi, "poster"));
    queries.add(toSpanishTypeFirst(raw, ["art print", "print"], "Poster"));
  }

  if (platform === "apparel") {
    queries.add(raw.replace(/\bapparel\b/gi, "ropa"));
    queries.add(raw.replace(/\bt-shirt\b/gi, "camiseta"));
    queries.add(raw.replace(/\bshirt\b/gi, "camiseta"));
  }

  if (platform === "pin") {
    queries.add(raw.replace(/\bpin\b/gi, "chapa"));
    queries.add(raw.replace(/\bpin\b/gi, "pins"));
  }

  const tokens = normalized.split(" ").filter(Boolean);

  if (tokens.length > 1) {
    queries.add(tokens.slice(0, 4).join(" "));
    queries.add(tokens.slice(0, 3).join(" "));
  }

  return [...queries]
    .map((query) => query.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((query, index, arr) => arr.indexOf(query) === index)
    .slice(0, 8);
}

function toSpanishTypeFirst(
  value: string,
  removableWords: string[],
  spanishType: string
): string {
  let clean = value;

  for (const word of removableWords) {
    clean = clean.replace(new RegExp(`\\b${escapeRegExp(word)}\\b`, "gi"), "");
  }

  clean = clean.replace(/\s+/g, " ").trim();

  return `${spanishType} ${clean}`.trim();
}

function buildSearchUrls(item: Item, query: string): string[] {
  const platform = normalizePlatform(item.platform);
  const paths = MERCH_CATEGORY_URLS[platform] ?? MERCH_CATEGORY_URLS.othermerch;

  const encoded = encodeURIComponent(query);
  const urls = new Set<string>();

  for (const path of paths) {
    urls.add(`${absolutize(path)}?search=${encoded}`);
    urls.add(`${absolutize(path)}?s=${encoded}`);
  }

  return [...urls];
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
      console.log("❌ Kurogami fetch failed:", res.status, url);
      return null;
    }

    return await res.text();
  } catch (error) {
    console.log("❌ Kurogami fetch error:", { url, error });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractCandidates(html: string): Candidate[] {
  const $ = cheerio.load(html);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_, el) => {
    const link = $(el);
    const href = link.attr("href") || "";
    const url = absolutize(href);

    if (!looksLikeProductUrl(url)) return;

    const root = link.closest("article, li, div");

    const title =
      link.text().trim() ||
      link.attr("title")?.trim() ||
      link.find("img").attr("alt")?.trim() ||
      root.find("h2, h3, .product-title, .product-name").first().text().trim() ||
      titleFromProductUrl(url);

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
    $("meta[property='og:title']").attr("content")?.trim() ||
    titleFromProductUrl(url);

  const price =
    parsePrice($(".price").first().text().trim()) ??
    parsePrice($("[class*='price']").first().text().trim()) ??
    parsePrice($("meta[property='product:price:amount']").attr("content")) ??
    extractPriceFromJson(html);

  return { title, price };
}

function filterCandidates(item: Item, candidates: Candidate[]): Candidate[] {
  const wanted = normalizeSearchText(item.name);
  const wantedTokens = getImportantTokens(wanted, item.platform);

  if (wantedTokens.length === 0) return [];

  return candidates.filter((candidate) => {
    const title = normalizeSearchText(candidate.title);

    const hasCoreTokens = wantedTokens.every((token) => title.includes(token));
    if (!hasCoreTokens) return false;

    const platform = normalizePlatform(item.platform);

    if (platform === "plush") return hasAny(title, ["peluche", "plush"]);
    if (platform === "mug") return hasAny(title, ["taza", "mug"]);
    if (platform === "poster" || platform === "artprint") {
      return hasAny(title, ["poster", "lamina", "lámina", "print"]);
    }
    if (platform === "keychain") return hasAny(title, ["llavero", "keychain"]);
    if (platform === "pin") return hasAny(title, ["pin", "pins", "chapa"]);
    if (platform === "mousepad") {
      return hasAny(title, ["alfombrilla", "mousepad", "tapete", "playmat"]);
    }
    if (platform === "apparel") {
      return hasAny(title, [
        "camiseta",
        "sudadera",
        "gorra",
        "ropa",
        "shirt",
        "hoodie",
        "cap"
      ]);
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

    if (title.includes(wanted)) score += 0.35;

    score += getPlatformBoost(item.platform, title);

    return { candidate, score };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log(
    "🧧 Kurogami top candidates:",
    scored.slice(0, 5).map((entry) => ({
      title: entry.candidate.title,
      price: entry.candidate.price,
      score: Number(entry.score.toFixed(2)),
      url: entry.candidate.url
    }))
  );

  const best = scored[0];

  if (!best || best.score < 0.58) return null;

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
  const maxAllowedDifference = listingPrice * 0.3;

  if (difference <= maxAllowedDifference) return detailPrice;

  return listingPrice;
}

function parsePrice(text: string | null | undefined): number | null {
  const value = String(text || "").trim();

  if (!value) return null;

  const matches = [...value.matchAll(/(\d{1,5}(?:[.,]\d{2})?)\s*€/g)];

  if (matches.length > 0) {
    return parseEuroPrice(matches[matches.length - 1][1]);
  }

  return parseEuroPrice(value);
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
  platform: string | null
): string[] {
  const stopWords = new Set(["the", "and", "pokemon", "pokémon"]);
  const platformWords = getPlatformWords(platform);

  for (const word of platformWords) {
    stopWords.add(word);
  }

  return normalizedText
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length > 2)
    .filter((token) => !stopWords.has(token));
}

function removePlatformWords(
  normalizedText: string,
  platform: string | null
): string {
  const platformWords = getPlatformWords(platform);

  return normalizedText
    .split(" ")
    .filter(Boolean)
    .filter((token) => !platformWords.includes(token))
    .join(" ")
    .trim();
}

function getPlatformBoost(platform: string | null, normalizedTitle: string): number {
  const type = normalizePlatform(platform);

  if (type === "plush" && hasAny(normalizedTitle, ["peluche", "plush"])) return 0.18;
  if (type === "mug" && hasAny(normalizedTitle, ["taza", "mug"])) return 0.18;
  if (type === "poster" && hasAny(normalizedTitle, ["poster"])) return 0.18;
  if (type === "keychain" && hasAny(normalizedTitle, ["llavero", "keychain"])) return 0.18;
  if (type === "pin" && hasAny(normalizedTitle, ["pin", "chapa"])) return 0.18;
  if (type === "mousepad" && hasAny(normalizedTitle, ["alfombrilla", "mousepad", "tapete", "playmat"])) return 0.18;
  if (type === "apparel" && hasAny(normalizedTitle, ["camiseta", "sudadera", "gorra", "shirt", "hoodie"])) return 0.18;

  return 0;
}

function getPlatformWords(platform: string | null): string[] {
  const type = normalizePlatform(platform);

  const words: Record<string, string[]> = {
    plush: ["plush", "peluche"],
    mug: ["mug", "taza"],
    poster: ["poster"],
    keychain: ["keychain", "llavero"],
    pin: ["pin", "pins", "chapa"],
    mousepad: ["mousepad", "alfombrilla", "tapete", "playmat"],
    apparel: ["apparel", "ropa", "camiseta", "shirt"],
    artprint: ["art", "print", "lamina", "lámina"],
    acrylicstand: ["acrylic", "stand"],
    othermerch: ["merch"]
  };

  return words[type] ?? [];
}

function normalizePlatform(value: string | null): string {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñ]+/g, "")
    .trim();

  if (!normalized) return "othermerch";

  if (normalized.includes("plush") || normalized.includes("peluche")) return "plush";
  if (normalized.includes("mug") || normalized.includes("taza")) return "mug";
  if (normalized.includes("poster")) return "poster";
  if (normalized.includes("keychain") || normalized.includes("llavero")) return "keychain";
  if (normalized.includes("pin") || normalized.includes("chapa")) return "pin";
  if (normalized.includes("mousepad") || normalized.includes("alfombrilla")) return "mousepad";
  if (normalized.includes("apparel") || normalized.includes("ropa")) return "apparel";
  if (normalized.includes("artprint")) return "artprint";
  if (normalized.includes("acrylicstand")) return "acrylicstand";

  return "othermerch";
}

function hasAny(value: string, tokens: string[]): boolean {
  return tokens.some((token) => value.includes(token));
}

function titleFromProductUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() || "";

    return last.replace(/-/g, " ").trim();
  } catch {
    return "";
  }
}

function looksLikeProductUrl(url: string): boolean {
  const normalized = url.toLowerCase();

  if (!normalized.startsWith("http")) return false;
  if (!normalized.includes("kurogami.com")) return false;
  if (!normalized.includes("/producto/") && !normalized.includes("/product/")) {
    return false;
  }
  if (normalized.includes("/galeria/")) return false;

  return true;
}

function normalizeSearchText(value: string): string {
  return normalizeText(value).replace(/\s+/g, " ").trim();
}

function cleanQuery(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanTitle(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function slugify(value: string): string {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim();
}

function absolutize(href: string): string {
  if (!href) return "";
  if (href.startsWith("http")) return href;
  if (href.startsWith("/")) return `${BASE_URL}${href}`;
  return `${BASE_URL}/${href}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function computeConfidence(item: Item, matchedTitle: string): number {
  const wanted = normalizeSearchText(item.name);
  const matched = normalizeSearchText(matchedTitle);

  let confidence = 0.48 + similarityScore(wanted, matched) * 0.42;

  if (matched.includes(wanted)) confidence += 0.06;

  confidence += getPlatformBoost(item.platform, matched);

  return Math.max(0.25, Math.min(0.9, Number(confidence.toFixed(2))));
}