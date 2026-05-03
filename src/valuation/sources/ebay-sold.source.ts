import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import { ScraperSourceResult } from "../scraper.types";
import { normalizeText, parseEuroPrice, similarityScore } from "../utils";

type ParsedTcgQuery = {
  cleanName: string;
  setCode: string | null;
  cardNumber: string | null;
  setName: string | null;
  totalNumber: string | null;
};

type EbaySoldCandidate = {
  title: string;
  price: number;
  currency: "EUR" | "USD" | "GBP" | null;
  url: string;
  soldText: string | null;
  score: number;
};

const EBAY_BASE_URL = "https://www.ebay.com";
const REQUEST_TIMEOUT_MS = 15000;

const KNOWN_SET_ALIASES: Record<string, { name: string; total?: string }> = {
  POR: {
    name: "Perfect Order",
    total: "088"
  }
};

export async function getEbaySoldPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (item.category !== "tcg") return null;

  const query = String(item.name || "").trim();
  if (!query) return null;

  const parsed = parseTcgQuery(item);
  const searchQueries = buildSearchQueries(parsed);

  console.log("🟩 EBAY SOLD called:", {
    itemId: item.id,
    name: item.name,
    parsed,
    searchQueries
  });

  const allCandidates: EbaySoldCandidate[] = [];
  const seen = new Set<string>();

  for (const searchQuery of searchQueries) {
    const url = buildSoldSearchUrl(searchQuery);

    console.log("🟩 EBAY SOLD Searching:", url);

    const html = await fetchHtml(url);
    if (!html) continue;

    const candidates = extractSoldCandidates(html, parsed);

    console.log(
      "🟩 EBAY SOLD candidates:",
      candidates.slice(0, 10).map((candidate) => ({
        title: candidate.title,
        price: candidate.price,
        currency: candidate.currency,
        score: Number(candidate.score.toFixed(2)),
        soldText: candidate.soldText,
        url: candidate.url
      }))
    );

    for (const candidate of candidates) {
      const key = `${normalizeText(candidate.title)}|${candidate.price}|${candidate.url}`;

      if (seen.has(key)) continue;
      seen.add(key);

      allCandidates.push(candidate);
    }
  }

  const valid = allCandidates
    .filter((candidate) => candidate.score >= 0.72)
    .filter((candidate) => candidate.price > 0)
    .filter((candidate) => candidate.price < 5000)
    .sort((a, b) => b.score - a.score);

  if (valid.length === 0) {
    console.log("🟩 EBAY SOLD no reliable sold candidates:", parsed);

    return null;
  }

  const valuationCandidates = removePriceOutliers(valid);
  const price = calculateMedian(valuationCandidates.map((candidate) => candidate.price));
  const confidence = computeConfidence(valuationCandidates);

  const best = valuationCandidates[0];

  if (!best || !price || price <= 0) return null;

  console.log("🟩 EBAY SOLD selected:", {
    price,
    confidence,
    samples: valuationCandidates.length,
    bestTitle: best.title,
    bestUrl: best.url
  });

  return {
    price: Number(price.toFixed(2)),
    source: "ebay_sold",
    confidence,
    matchedTitle: best.title,
    matchedUrl: best.url,
    query,
    metadata: {
      provider: "ebay_sold",
      pricingBasis: "median_sold_listings",
      samples: valuationCandidates.length,
      parsed,
      candidates: valuationCandidates.slice(0, 12).map((candidate) => ({
        title: candidate.title,
        price: candidate.price,
        currency: candidate.currency,
        url: candidate.url,
        soldText: candidate.soldText,
        score: candidate.score
      }))
    }
  };
}

function buildSoldSearchUrl(query: string): string {
  const params = new URLSearchParams({
    _nkw: query,
    _sacat: "0",
    LH_Sold: "1",
    LH_Complete: "1",
    _ipg: "60"
  });

  return `${EBAY_BASE_URL}/sch/i.html?${params.toString()}`;
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
        Referer: EBAY_BASE_URL
      }
    });

    if (!res.ok) {
      console.log("❌ EBAY SOLD fetch failed:", {
        status: res.status,
        url
      });

      return null;
    }

    return await res.text();
  } catch (err) {
    console.log("❌ EBAY SOLD fetch error:", {
      url,
      error: err
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractSoldCandidates(
  html: string,
  parsed: ParsedTcgQuery
): EbaySoldCandidate[] {
  const $ = cheerio.load(html);
  const candidates: EbaySoldCandidate[] = [];

  $(".s-item").each((_, el) => {
    const root = $(el);

    const title =
      cleanTitle(root.find(".s-item__title").first().text()) ||
      cleanTitle(root.find("a.s-item__link").first().text());

    if (!title || title.toLowerCase().includes("shop on ebay")) return;

    const priceText =
      root.find(".s-item__price").first().text().trim() ||
      root.find("[class*='price']").first().text().trim();

    const price = parsePrice(priceText);
    if (!price || price <= 0) return;

    const currency = parseCurrency(priceText);

    const url =
      root.find("a.s-item__link").first().attr("href")?.trim() ||
      "";

    if (!url) return;

    const soldText =
      root.find(".s-item__title--tagblock").first().text().trim() ||
      root.find(".s-item__ended-date").first().text().trim() ||
      root.text().match(/Sold\s+[A-Za-z0-9, ]+/i)?.[0] ||
      null;

    const score = scoreSoldCandidate(parsed, title);

    if (score <= 0) return;

    candidates.push({
      title,
      price,
      currency,
      url,
      soldText,
      score
    });
  });

  return candidates.sort((a, b) => b.score - a.score);
}

function scoreSoldCandidate(parsed: ParsedTcgQuery, title: string): number {
  const wantedName = normalizeText(parsed.cleanName);
  const normalizedTitle = normalizeText(title);

  let score = similarityScore(wantedName, normalizedTitle);

  if (normalizedTitle.includes(wantedName)) score += 0.35;

  const wantedTokens = wantedName.split(" ").filter(Boolean);

  for (const token of wantedTokens) {
    if (normalizedTitle.includes(token)) score += 0.08;
  }

  if (parsed.cardNumber && normalizedTitle.includes(normalizeText(parsed.cardNumber))) {
    score += 0.3;
  }

  if (parsed.totalNumber && normalizedTitle.includes(normalizeText(parsed.totalNumber))) {
    score += 0.15;
  }

  if (
    parsed.cardNumber &&
    parsed.totalNumber &&
    normalizedTitle.includes(`${normalizeText(parsed.cardNumber)} ${normalizeText(parsed.totalNumber)}`)
  ) {
    score += 0.2;
  }

  if (parsed.setName && normalizedTitle.includes(normalizeText(parsed.setName))) {
    score += 0.35;
  }

  if (parsed.setCode && normalizedTitle.includes(normalizeText(parsed.setCode))) {
    score += 0.18;
  }

  if (isBadTcgTitle(normalizedTitle)) {
    score -= 0.45;
  }

  return Number(Math.max(0, score).toFixed(4));
}

function isBadTcgTitle(normalizedTitle: string): boolean {
  const badTokens = [
    "digital",
    "proxy",
    "custom",
    "jumbo",
    "oversized",
    "lot",
    "bundle",
    "pack",
    "booster",
    "code card",
    "online code",
    "empty",
    "orica"
  ];

  return badTokens.some((token) => normalizedTitle.includes(token));
}

function buildSearchQueries(parsed: ParsedTcgQuery): string[] {
  const queries: string[] = [];

  const quotedName = `"${parsed.cleanName}"`;

  if (parsed.cardNumber && parsed.setName) {
    queries.push(`${quotedName} ${parsed.cardNumber} "${parsed.setName}"`);
  }

  if (parsed.cardNumber && parsed.totalNumber) {
    queries.push(`${quotedName} ${parsed.cardNumber}/${parsed.totalNumber}`);
  }

  if (parsed.cardNumber && parsed.setCode) {
    queries.push(`${quotedName} ${parsed.setCode} ${parsed.cardNumber}`);
  }

  if (parsed.cardNumber) {
    queries.push(`${quotedName} ${parsed.cardNumber}`);
  }

  queries.push(parsed.cleanName);

  return [...new Set(queries)];
}

function parseTcgQuery(item: Item): ParsedTcgQuery {
  const rawName = String(item.name || "").trim();
  const platform = String(item.platform || "").trim();
  const region = String(item.region || "").trim();

  const parenthesisMatch = rawName.match(/\(([^)]+)\)/);
  const content = parenthesisMatch?.[1] ?? "";

  const parts = content
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const setCode =
    platform ||
    parts.find((part) => /^[A-Z0-9]{2,8}$/i.test(part)) ||
    null;

  const cardNumber =
    region ||
    parts.find((part) => /^\d+[a-zA-Z]?\/?\d*[a-zA-Z]?$/.test(part)) ||
    rawName.match(/\b(\d+[a-zA-Z]?\/?\d*[a-zA-Z]?)\b/)?.[1] ||
    null;

  const cleanName = rawName
    .replace(/\([^)]*\)/g, "")
    .replace(/\b\d+[a-zA-Z]?\/?\d*[a-zA-Z]?\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const normalizedSetCode = setCode ? normalizeSetCode(setCode) : null;
  const knownSet = normalizedSetCode ? KNOWN_SET_ALIASES[normalizedSetCode] : null;

  return {
    cleanName: cleanName || rawName,
    setCode: normalizedSetCode,
    cardNumber: cardNumber ? normalizeCardNumber(cardNumber) : null,
    setName: knownSet?.name ?? null,
    totalNumber: knownSet?.total ?? null
  };
}

function removePriceOutliers(candidates: EbaySoldCandidate[]): EbaySoldCandidate[] {
  if (candidates.length <= 3) return candidates;

  const prices = candidates.map((candidate) => candidate.price).sort((a, b) => a - b);
  const median = calculateMedian(prices);

  if (!median || median <= 0) return candidates;

  const min = median * 0.25;
  const max = median * 4;

  const filtered = candidates.filter(
    (candidate) => candidate.price >= min && candidate.price <= max
  );

  return filtered.length > 0 ? filtered : candidates;
}

function calculateMedian(values: number[]): number | null {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);

  if (sorted.length === 0) return null;

  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    const left = sorted[middle - 1];
    const right = sorted[middle];

    return (left + right) / 2;
  }

  return sorted[middle];
}

function computeConfidence(candidates: EbaySoldCandidate[]): number {
  const count = candidates.length;
  const avgScore =
    candidates.reduce((acc, candidate) => acc + candidate.score, 0) / count;

  let confidence = 0.45;

  confidence += Math.min(0.25, avgScore * 0.12);
  confidence += Math.min(0.25, count * 0.04);

  return Math.max(0.5, Math.min(0.9, Number(confidence.toFixed(2))));
}

function parsePrice(value: string | null | undefined): number | null {
  const raw = String(value || "").trim();
  if (!raw) return null;

  if (raw.includes(" to ") || raw.includes(" - ")) return null;

  const euro = parseEuroPrice(raw);
  if (euro && euro > 0) return euro;

  const match = raw.match(/(?:€|\$|£)?\s*(\d{1,6}(?:[.,]\d{1,2})?)/);
  if (!match) return null;

  const cleaned = match[1]
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");

  const parsed = Number(cleaned);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseCurrency(value: string): "EUR" | "USD" | "GBP" | null {
  if (value.includes("€")) return "EUR";
  if (value.includes("$")) return "USD";
  if (value.includes("£")) return "GBP";
  return null;
}

function normalizeSetCode(value: string): string {
  return String(value || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .trim();
}

function normalizeCardNumber(value: string): string {
  return String(value || "")
    .split("/")[0]
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .trim();
}

function cleanTitle(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^New Listing/i, "")
    .trim();
}