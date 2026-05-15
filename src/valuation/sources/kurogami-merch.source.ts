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
  plush: [
    "/es/categoria/peluches-anime",
    "/es/categoria/peluches-videojuegos",
    "/es/categoria/peluches-cine",
    "/en/category/anime-plush-toys",
    "/en/category/video-game-plush-toys"
  ],
  mug: [
    "/es/categoria/tazas-anime",
    "/es/categoria/tazas-videojuegos",
    "/es/categoria/tazas-cine",
    "/en/category/anime-mugs",
    "/en/category/video-game-mugs"
  ],
  poster: [
    "/es/categoria/posters-anime",
    "/es/categoria/posters-videojuegos",
    "/es/categoria/posters-cine",
    "/en/category/anime-posters",
    "/en/category/video-game-posters"
  ],
  keychain: [
    "/es/categoria/llaveros-anime",
    "/es/categoria/llaveros-videojuegos",
    "/es/categoria/llaveros-cine",
    "/en/category/anime-keychains",
    "/en/category/video-game-keychains"
  ],
  pin: [
    "/es/categoria/pins-anime",
    "/es/categoria/pins-videojuegos",
    "/es/categoria/pins-cine",
    "/en/category/anime-pins",
    "/en/category/video-game-pins"
  ],
  mousepad: [
    "/es/categoria/alfombrillas-anime",
    "/es/categoria/alfombrillas-videojuegos",
    "/es/categoria/alfombrillas-cine",
    "/en/category/anime-mouse-pads",
    "/en/category/video-game-mouse-pads"
  ],
  apparel: [
    "/es/categoria/ropa-friki",
    "/en/category/geek-clothes"
  ],
  artprint: [
    "/es/categoria/posters-anime",
    "/es/categoria/posters-videojuegos",
    "/en/category/anime-posters",
    "/en/category/video-game-posters"
  ],
  acrylicstand: [
    "/es/familia/regalos-anime",
    "/es/familia/merchandising-kurogami",
    "/en/category/anime-gifts"
  ],
  othermerch: [
    "/es/familia/regalos-anime",
    "/es/familia/regalos-videojuegos",
    "/es/familia/merchandising-kurogami",
    "/en/category/anime-gifts",
    "/en/category/video-game-gifts"
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

  if (!SUPPORTED_CATEGORIES.has(item.category)) {
    return null;
  }

  const query = cleanQuery(item.name);
  if (!query) return null;

  const urls = buildSearchUrls(item, query);

  for (const url of urls) {
    console.log("🧧 Kurogami crawling:", url);

    const html = await fetchHtml(url);
    if (!html) continue;

    console.log("🧧 Kurogami html length:", html.length);

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

    const detail = await fetchDetail(best.url);

    const finalPrice = chooseFinalPrice(best.price, detail?.price ?? null);

    if (!finalPrice || finalPrice <= 0) {
      console.log("🧧 Kurogami matched but no usable price:", {
        title: best.title,
        url: best.url,
        listingPrice: best.price,
        detailPrice: detail?.price
      });

      continue;
    }

    const matchedTitle = detail?.title || best.title;
    const confidence = computeConfidence(item, matchedTitle);

    console.log("🧧 Kurogami selected:", {
      title: matchedTitle,
      listingPrice: best.price,
      detailPrice: detail?.price,
      finalPrice,
      confidence,
      url: best.url
    });

    return {
      price: Number(finalPrice.toFixed(2)),
      currency: "EUR",
      source: "kurogami_merch",
      confidence,
      matchedTitle,
      matchedUrl: best.url,
      query,
      metadata: {
        provider: "kurogami",
        currency: "EUR",
        category: item.category,
        platform: item.platform ?? null,
        url: best.url
      }
    };
  }

  return null;
}

function buildSearchUrls(item: Item, query: string): string[] {
  const platform = normalizePlatform(item.platform);
  const paths = MERCH_CATEGORY_URLS[platform] ?? MERCH_CATEGORY_URLS.othermerch;

  const urls = new Set<string>();

  for (const path of paths) {
    urls.add(absolutize(path));
  }

  const clean = cleanQuery(query);
  const normalized = normalizeSearchText(clean);
  const tokens = normalized.split(" ").filter(Boolean);

  const reducedQueries = [
    clean,
    tokens.slice(0, 4).join(" "),
    tokens.slice(0, 3).join(" "),
    tokens.slice(0, 2).join(" ")
  ]
    .map((value) => value.trim())
    .filter(Boolean);

  for (const searchQuery of reducedQueries) {
    const encoded = encodeURIComponent(searchQuery);

    urls.add(`${BASE_URL}/es/tienda?search=${encoded}`);
    urls.add(`${BASE_URL}/en/store?search=${encoded}`);
    urls.add(`${BASE_URL}/es/search?search=${encoded}`);
    urls.add(`${BASE_URL}/en/search?search=${encoded}`);
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
    console.log("❌ Kurogami fetch error:", {
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

  candidatesPushSafe(input.candidates, {
    title,
    price,
    url
  });
}

function candidatesPushSafe(candidates: Candidate[], candidate: Candidate) {
  if (candidate.title.length < 3) return;
  candidates.push(candidate);
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
    parsePrice($("meta[property='product:price:amount']").attr("content")) ??
    extractPriceFromJson(html);

  return {
    title,
    price
  };
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

    if (platform === "plush") {
      return hasAny(title, ["peluche", "plush"]);
    }

    if (platform === "mug") {
      return hasAny(title, ["taza", "mug"]);
    }

    if (platform === "poster" || platform === "artprint") {
      return hasAny(title, ["poster", "lamina", "lámina", "print"]);
    }

    if (platform === "keychain") {
      return hasAny(title, ["llavero", "keychain"]);
    }

    if (platform === "pin") {
      return hasAny(title, ["pin", "pins", "chapa"]);
    }

    if (platform === "mousepad") {
      return hasAny(title, ["alfombrilla", "mouse", "mousepad", "tapete"]);
    }

    if (platform === "apparel") {
      return hasAny(title, ["camiseta", "sudadera", "gorra", "ropa", "shirt", "hoodie", "cap"]);
    }

    return true;
  });
}

function pickBestCandidate(
  item: Item,
  candidates: Candidate[]
): Candidate | null {
  if (candidates.length === 0) return null;

  const wanted = normalizeSearchText(item.name);

  const scored = candidates.map((candidate) => {
    const title = normalizeSearchText(candidate.title);

    let score = similarityScore(wanted, title);

    if (title.includes(wanted)) score += 0.35;

    const platformBoost = getPlatformBoost(item.platform, title);
    score += platformBoost;

    return {
      candidate,
      score
    };
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

  if (!detailPrice || detailPrice <= 0) {
    return listingPrice;
  }

  const difference = Math.abs(detailPrice - listingPrice);
  const maxAllowedDifference = listingPrice * 0.3;

  if (difference <= maxAllowedDifference) {
    return detailPrice;
  }

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
  const stopWords = new Set([
    "the",
    "and",
    "pokemon",
    "pokémon"
  ]);

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

function getPlatformBoost(platform: string | null, normalizedTitle: string): number {
  const type = normalizePlatform(platform);

  if (type === "plush" && hasAny(normalizedTitle, ["peluche", "plush"])) return 0.18;
  if (type === "mug" && hasAny(normalizedTitle, ["taza", "mug"])) return 0.18;
  if (type === "poster" && hasAny(normalizedTitle, ["poster"])) return 0.18;
  if (type === "keychain" && hasAny(normalizedTitle, ["llavero", "keychain"])) return 0.18;
  if (type === "pin" && hasAny(normalizedTitle, ["pin", "chapa"])) return 0.18;
  if (type === "mousepad" && hasAny(normalizedTitle, ["alfombrilla", "mousepad", "tapete"])) return 0.18;
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
    mousepad: ["mousepad", "alfombrilla", "tapete"],
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
    .replace(/[^a-z0-9]+/g, "")
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

    return last
      .replace(/\.html$/i, "")
      .replace(/-/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function looksLikeProductUrl(url: string): boolean {
  const normalized = url.toLowerCase();

  if (!normalized.startsWith("http")) return false;
  if (!normalized.includes("kurogami.com")) return false;
  if (!normalized.includes("/producto/") && !normalized.includes("/product/")) return false;
  if (normalized.includes("/galeria/")) return false;

  return true;
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

function absolutize(href: string): string {
  if (!href) return "";

  if (href.startsWith("http")) return href;

  if (href.startsWith("/")) {
    return `${BASE_URL}${href}`;
  }

  return `${BASE_URL}/${href}`;
}

function computeConfidence(item: Item, matchedTitle: string): number {
  const wanted = normalizeSearchText(item.name);
  const matched = normalizeSearchText(matchedTitle);

  let confidence = 0.48 + similarityScore(wanted, matched) * 0.42;

  if (matched.includes(wanted)) {
    confidence += 0.06;
  }

  confidence += getPlatformBoost(item.platform, matched);

  return Math.max(
    0.25,
    Math.min(0.9, Number(confidence.toFixed(2)))
  );
}