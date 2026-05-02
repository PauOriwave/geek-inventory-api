import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import { ScraperSourceResult } from "../scraper.types";
import { normalizeText, parseEuroPrice, similarityScore } from "../utils";

type CardMarketGame =
  | "Magic"
  | "Pokemon"
  | "YuGiOh"
  | "OnePiece"
  | "Lorcana"
  | "FleshAndBlood"
  | "Digimon"
  | "DragonBallSuper"
  | "CardfightVanguard"
  | "WeissSchwarz"
  | "FinalFantasy"
  | "StarWarsUnlimited";

type CardMarketCandidate = {
  title: string;
  url: string;
  price: number | null;
  game: CardMarketGame;
};

type CardMarketDetail = {
  title: string;
  url: string;
  price: number;
  priceBasis: string;
  availableFrom: number | null;
  trendPrice: number | null;
  avg7: number | null;
  avg30: number | null;
  avgPrice: number | null;
  lowPrice: number | null;
};

const BASE_URL = "https://www.cardmarket.com";
const REQUEST_TIMEOUT_MS = 15000;

export async function getCardMarketPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (item.category !== "tcg") return null;

  const query = String(item.name || "").trim();
  if (!query) return null;

  const games = getCandidateGames(item);

  console.log("🃏 CM called:", {
    itemId: item.id,
    name: item.name,
    category: item.category,
    platform: item.platform,
    games
  });

  for (const game of games) {
    const candidates = await searchCardMarket(game, query);

    if (candidates.length === 0) continue;

    const best = pickBestCandidate(item, candidates);

    if (!best) {
      console.log("🃏 CM candidates found but no reliable match:", {
        game,
        query
      });
      continue;
    }

    const detail = await fetchCardMarketDetail(best);

    if (!detail) continue;

    const confidence = computeConfidence(item, detail, best);

    console.log("🃏 CM selected:", {
      game,
      title: detail.title,
      price: detail.price,
      priceBasis: detail.priceBasis,
      confidence,
      url: detail.url
    });

    return {
      price: Number(detail.price.toFixed(2)),
      source: "cardmarket",
      confidence,
      matchedTitle: detail.title,
      matchedUrl: detail.url,
      query,
      metadata: {
        game,
        priceBasis: detail.priceBasis,
        availableFrom: detail.availableFrom,
        trendPrice: detail.trendPrice,
        avg7: detail.avg7,
        avg30: detail.avg30,
        avgPrice: detail.avgPrice,
        lowPrice: detail.lowPrice,
        cardmarketUrl: detail.url
      }
    };
  }

  return null;
}

async function searchCardMarket(
  game: CardMarketGame,
  query: string
): Promise<CardMarketCandidate[]> {
  const searchUrls = buildSearchUrls(game, query);
  const candidates: CardMarketCandidate[] = [];
  const seen = new Set<string>();

  for (const url of searchUrls) {
    console.log("🃏 CM Searching:", url);

    const html = await fetchHtml(url);
    if (!html) continue;

    const extracted = extractSearchCandidates(html, game);

    console.log("🃏 CM candidates:", {
      game,
      count: extracted.length
    });

    for (const candidate of extracted) {
      const key = `${normalizeText(candidate.title)}|${candidate.url}`;

      if (seen.has(key)) continue;
      seen.add(key);

      candidates.push(candidate);
    }

    if (candidates.length > 0) break;
  }

  return candidates;
}

function buildSearchUrls(game: CardMarketGame, query: string): string[] {
  const encoded = encodeURIComponent(query);

  return [
    `${BASE_URL}/en/${game}/Products/Search?searchString=${encoded}`,
    `${BASE_URL}/en/${game}/Products/Singles?searchString=${encoded}`,
    `${BASE_URL}/en/${game}/Products/Search?mode=gallery&searchString=${encoded}`,
    `${BASE_URL}/en/${game}?searchString=${encoded}`
  ];
}

async function fetchCardMarketDetail(
  candidate: CardMarketCandidate
): Promise<CardMarketDetail | null> {
  const html = await fetchHtml(candidate.url);
  if (!html) return null;

  const $ = cheerio.load(html);
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  const title =
    cleanTitle($("h1").first().text()) ||
    cleanTitle($("meta[property='og:title']").attr("content") || "") ||
    candidate.title;

  const availableFrom =
    extractPriceAfterLabel(bodyText, ["Available from", "From"]) ??
    candidate.price;

  const trendPrice = extractPriceAfterLabel(bodyText, ["Trend", "Trend Price"]);
  const avg7 = extractPriceAfterLabel(bodyText, ["7-days average", "7 day average", "7-day average"]);
  const avg30 = extractPriceAfterLabel(bodyText, ["30-days average", "30 day average", "30-day average"]);
  const avgPrice = extractPriceAfterLabel(bodyText, ["Average", "Average Price"]);
  const lowPrice = extractPriceAfterLabel(bodyText, ["Low", "Low Price"]);

  const selected =
    trendPrice ??
    avg30 ??
    avg7 ??
    avgPrice ??
    availableFrom ??
    lowPrice ??
    candidate.price;

  if (!selected || selected <= 0) {
    console.log("🃏 CM detail without usable price:", {
      title,
      url: candidate.url,
      availableFrom,
      trendPrice,
      avg7,
      avg30,
      avgPrice,
      lowPrice,
      candidatePrice: candidate.price
    });

    return null;
  }

  return {
    title,
    url: candidate.url,
    price: selected,
    priceBasis: selectPriceBasis({
      selected,
      availableFrom,
      trendPrice,
      avg7,
      avg30,
      avgPrice,
      lowPrice,
      candidatePrice: candidate.price
    }),
    availableFrom,
    trendPrice,
    avg7,
    avg30,
    avgPrice,
    lowPrice
  };
}

function extractSearchCandidates(
  html: string,
  game: CardMarketGame
): CardMarketCandidate[] {
  const $ = cheerio.load(html);
  const candidates: CardMarketCandidate[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_, el) => {
    const link = $(el);
    const href = decodeHtml(link.attr("href") || "");
    const url = absolutize(href);

    if (!looksLikeProductUrl(url, game)) return;

    const root = link.closest("article, li, div, tr, section");

    const title =
      cleanTitle(link.text()) ||
      cleanTitle(link.attr("title") || "") ||
      cleanTitle(root.find("h1, h2, h3, h4").first().text()) ||
      cleanTitle(root.text()) ||
      titleFromUrl(url);

    if (!title) return;

    const price =
      extractFirstEuroPrice(root.text()) ??
      extractFirstEuroPrice(link.text());

    const key = `${normalizeText(title)}|${url}`;

    if (seen.has(key)) return;
    seen.add(key);

    candidates.push({
      title,
      url,
      price,
      game
    });
  });

  return candidates;
}

function pickBestCandidate(
  item: Item,
  candidates: CardMarketCandidate[]
): CardMarketCandidate | null {
  const wanted = normalizeCardText(item.name);

  const scored = candidates.map((candidate) => {
    const title = normalizeCardText(candidate.title);
    const url = normalizeCardText(candidate.url);

    let score = similarityScore(wanted, title);

    if (title.includes(wanted)) score += 0.35;
    if (wanted.includes(title)) score += 0.15;
    if (url.includes(wanted.replace(/\s+/g, "-"))) score += 0.2;
    if (candidate.price && candidate.price > 0) score += 0.05;

    const wantedTokens = getImportantTokens(wanted);
    const matchedTokens = wantedTokens.filter(
      (token) => title.includes(token) || url.includes(token)
    );

    if (wantedTokens.length > 0) {
      score += (matchedTokens.length / wantedTokens.length) * 0.3;
    }

    return {
      candidate,
      score: Number(score.toFixed(4))
    };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log(
    "🃏 CM top:",
    scored.slice(0, 8).map((entry) => ({
      title: entry.candidate.title,
      price: entry.candidate.price,
      score: Number(entry.score.toFixed(2)),
      url: entry.candidate.url
    }))
  );

  const best = scored[0];

  if (!best) return null;
  if (best.score < 0.35) return null;

  return best.candidate;
}

function computeConfidence(
  item: Item,
  detail: CardMarketDetail,
  candidate: CardMarketCandidate
): number {
  const wanted = normalizeCardText(item.name);
  const matched = normalizeCardText(detail.title);

  let confidence = 0.45 + similarityScore(wanted, matched) * 0.4;

  if (matched.includes(wanted)) confidence += 0.08;
  if (detail.trendPrice) confidence += 0.08;
  if (detail.avg30) confidence += 0.05;
  if (candidate.price) confidence += 0.03;

  return Math.max(0.45, Math.min(0.92, Number(confidence.toFixed(2))));
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
      console.log("❌ CM fetch failed:", {
        status: res.status,
        url
      });

      return null;
    }

    return await res.text();
  } catch (err) {
    console.log("❌ CM fetch error:", {
      url,
      error: err
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function getCandidateGames(item: Item): CardMarketGame[] {
  const platform = normalizeText(item.platform ?? "");
  const name = normalizeText(item.name ?? "");
  const combined = `${platform} ${name}`;

  if (combined.includes("magic") || combined.includes("mtg")) return ["Magic"];
  if (combined.includes("pokemon") || combined.includes("pokémon")) return ["Pokemon"];
  if (combined.includes("yugioh") || combined.includes("yu gi oh") || combined.includes("yu-gi-oh")) return ["YuGiOh"];
  if (combined.includes("one piece")) return ["OnePiece"];
  if (combined.includes("lorcana")) return ["Lorcana"];
  if (combined.includes("flesh") || combined.includes("fab")) return ["FleshAndBlood"];
  if (combined.includes("digimon")) return ["Digimon"];
  if (combined.includes("dragon ball")) return ["DragonBallSuper"];
  if (combined.includes("vanguard")) return ["CardfightVanguard"];
  if (combined.includes("weiss") || combined.includes("weiß")) return ["WeissSchwarz"];
  if (combined.includes("final fantasy")) return ["FinalFantasy"];
  if (combined.includes("star wars unlimited")) return ["StarWarsUnlimited"];

  return [
    "Magic",
    "Pokemon",
    "YuGiOh",
    "OnePiece",
    "Lorcana",
    "FleshAndBlood",
    "Digimon"
  ];
}

function looksLikeProductUrl(url: string, game: CardMarketGame): boolean {
  const normalized = url.toLowerCase();

  if (!normalized.startsWith("http")) return false;
  if (!normalized.includes("cardmarket.com")) return false;
  if (!normalized.includes(`/en/${game.toLowerCase()}/`.toLowerCase())) return false;

  if (normalized.includes("/users/")) return false;
  if (normalized.includes("/offers/")) return false;
  if (normalized.includes("/seller/")) return false;
  if (normalized.includes("/advancedsearch")) return false;
  if (normalized.includes("/search?")) return false;

  return normalized.includes("/products/");
}

function extractPriceAfterLabel(
  text: string,
  labels: string[]
): number | null {
  for (const label of labels) {
    const escapedLabel = escapeRegExp(label);

    const patterns = [
      new RegExp(
        `\\b${escapedLabel}\\b\\s*[:\\-]?\\s*€\\s*(\\d{1,6}(?:[.,]\\d{1,2})?)`,
        "i"
      ),
      new RegExp(
        `\\b${escapedLabel}\\b\\s*[:\\-]?\\s*(\\d{1,6}(?:[.,]\\d{1,2})?)\\s*€`,
        "i"
      ),
      new RegExp(
        `\\b${escapedLabel}\\b.{0,80}?€\\s*(\\d{1,6}(?:[.,]\\d{1,2})?)`,
        "i"
      ),
      new RegExp(
        `\\b${escapedLabel}\\b.{0,80}?(\\d{1,6}(?:[.,]\\d{1,2})?)\\s*€`,
        "i"
      )
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match) continue;

      const parsed = parseCardMarketPrice(match[1]);

      if (parsed && parsed > 0) {
        return parsed;
      }
    }
  }

  return null;
}

function extractFirstEuroPrice(text: string): number | null {
  const match =
    text.match(/€\s*(\d{1,6}(?:[.,]\d{1,2})?)/) ||
    text.match(/(\d{1,6}(?:[.,]\d{1,2})?)\s*€/);

  return parseCardMarketPrice(match?.[1]);
}

function parseCardMarketPrice(value: string | null | undefined): number | null {
  const parsed = parseEuroPrice(value);
  if (parsed && parsed > 0) return parsed;

  const raw = String(value || "").trim();
  if (!raw) return null;

  const cleaned = raw
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");

  const numeric = Number(cleaned);

  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function selectPriceBasis(input: {
  selected: number;
  availableFrom: number | null;
  trendPrice: number | null;
  avg7: number | null;
  avg30: number | null;
  avgPrice: number | null;
  lowPrice: number | null;
  candidatePrice: number | null;
}): string {
  if (input.trendPrice === input.selected) return "trendPrice";
  if (input.avg30 === input.selected) return "avg30";
  if (input.avg7 === input.selected) return "avg7";
  if (input.avgPrice === input.selected) return "avgPrice";
  if (input.availableFrom === input.selected) return "availableFrom";
  if (input.lowPrice === input.selected) return "lowPrice";
  if (input.candidatePrice === input.selected) return "candidatePrice";
  return "unknown";
}

function normalizeCardText(value: string): string {
  return normalizeText(value)
    .replace(/\bfoil\b/g, "")
    .replace(/\breverse\b/g, "")
    .replace(/\bholo\b/g, "")
    .replace(/\bnear mint\b/g, "")
    .replace(/\bnm\b/g, "")
    .replace(/\benglish\b/g, "")
    .replace(/\bspanish\b/g, "")
    .replace(/\bespanol\b/g, "")
    .replace(/\bespañol\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getImportantTokens(value: string): string[] {
  const stopWords = new Set([
    "the",
    "and",
    "or",
    "de",
    "del",
    "la",
    "el",
    "los",
    "las",
    "una",
    "uno",
    "card",
    "tcg"
  ]);

  return normalizeCardText(value)
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length > 2)
    .filter((token) => !stopWords.has(token));
}

function cleanTitle(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/Buy\s*/gi, "")
    .replace(/Sell\s*/gi, "")
    .trim();
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() || "";

    return decodeURIComponent(last)
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function absolutize(href: string): string {
  if (!href) return "";
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `${BASE_URL}${href}`;
  return `${BASE_URL}/${href}`;
}