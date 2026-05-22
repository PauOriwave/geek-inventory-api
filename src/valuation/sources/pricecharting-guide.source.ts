import { Item } from "@prisma/client";
import * as cheerio from "cheerio";

import {
  normalizeText,
  similarityScore
} from "../utils";

import { ScraperSourceResult } from "../scraper.types";

type PriceKind =
  | "complete"
  | "itemAndManual"
  | "itemAndBox"
  | "loose"
  | "market";

type Candidate = {
  title: string;
  price: number | null;
  url: string;
  priceKind?: PriceKind;
  metadata?: Record<string, unknown>;
};

const BASE_URL = "https://www.pricecharting.com";
const MIN_WEAK_GUIDE_PRICE_USD = 12;
const MIN_DIRECT_MATCH_SCORE = 0.48;
const MIN_SEARCH_MATCH_SCORE = 0.55;

export async function getPriceChartingGuidePrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  console.log("📘 PriceCharting Guide called:", {
    itemId: item.id,
    name: item.name,
    category: item.category,
    platform: item.platform,
    region: item.region
  });

  if (normalizeCategory(item.category) !== "guide") {
    return null;
  }

  const directUrls = buildDirectProductUrls(item);

  for (const directUrl of directUrls) {
    console.log("📘 PriceCharting Guide trying direct:", directUrl);

    const html = await fetchHtml(directUrl);

    if (!html) continue;

    const detail = extractDirectDetail(html, directUrl);

    console.log("📘 PriceCharting Guide direct detail:", {
      title: detail?.title,
      price: detail?.price,
      priceKind: detail?.priceKind,
      metadata: detail?.metadata,
      url: directUrl
    });

    if (!detail || !detail.price || detail.price <= 0) {
      continue;
    }

    const match = scoreGuideMatch(item, detail.title);

    if (!isReliableDirectMatch(item, detail.title, match.score)) {
      console.log("📘 PriceCharting Guide direct rejected match:", {
        wanted: item.name,
        matchedTitle: detail.title,
        score: Number(match.score.toFixed(2)),
        reasons: match.reasons,
        url: directUrl
      });

      continue;
    }

    if (!isReliableGuidePrice(item, detail.price, detail.priceKind, detail.title)) {
      console.log("📘 PriceCharting Guide direct rejected price:", {
        wanted: item.name,
        matchedTitle: detail.title,
        price: detail.price,
        priceKind: detail.priceKind,
        url: directUrl
      });

      continue;
    }

    const confidence = computeConfidence(item, detail.title, detail.priceKind);

    console.log("📘 PriceCharting Guide direct selected:", {
      title: detail.title,
      price: detail.price,
      priceKind: detail.priceKind,
      confidence,
      score: Number(match.score.toFixed(2)),
      reasons: match.reasons,
      url: directUrl
    });

    return {
      price: Number(detail.price.toFixed(2)),
      currency: "USD",
      source: "pricecharting_guide",
      confidence,
      matchedTitle: detail.title,
      matchedUrl: directUrl,
      query: item.name,
      metadata: {
        provider: "pricecharting",
        mode: "direct",
        url: directUrl,
        priceKind: detail.priceKind,
        priceRole: "historical",
        liquidity: "low",
        prices: detail.metadata ?? {},
        matchReasons: match.reasons,
        matchScore: Number(match.score.toFixed(3))
      }
    };
  }

  const queries = buildQueries(item);

  for (const query of queries) {
    const searchUrl =
      `${BASE_URL}/search-products?q=${encodeURIComponent(query)}`;

    console.log("📘 PriceCharting Guide searching:", searchUrl);

    const html = await fetchHtml(searchUrl);

    if (!html) continue;

    const candidates = extractCandidates(html);

    console.log(
      "📘 PriceCharting Guide candidates:",
      candidates.slice(0, 20).map((candidate) => ({
        title: candidate.title,
        price: candidate.price,
        priceKind: candidate.priceKind,
        url: candidate.url
      }))
    );

    const filtered = filterCandidates(item, candidates);

    console.log(
      "📘 PriceCharting Guide filtered:",
      filtered.slice(0, 20).map((candidate) => ({
        title: candidate.title,
        price: candidate.price,
        priceKind: candidate.priceKind,
        url: candidate.url
      }))
    );

    const best = pickBestCandidate(item, filtered);

    if (!best) continue;

    if (!isReliableGuidePrice(item, best.price, best.priceKind, best.title)) {
      console.log("📘 PriceCharting Guide search rejected price:", {
        wanted: item.name,
        matchedTitle: best.title,
        price: best.price,
        priceKind: best.priceKind,
        url: best.url
      });

      continue;
    }

    const confidence = computeConfidence(item, best.title, best.priceKind);

    console.log("📘 PriceCharting Guide selected:", {
      title: best.title,
      price: best.price,
      priceKind: best.priceKind,
      confidence
    });

    return {
      price: Number((best.price || 0).toFixed(2)),
      currency: "USD",
      source: "pricecharting_guide",
      confidence,
      matchedTitle: best.title,
      matchedUrl: best.url,
      query,
      metadata: {
        provider: "pricecharting",
        mode: "search",
        url: best.url,
        priceKind: best.priceKind,
        priceRole: "historical",
        liquidity: "low",
        ...(best.metadata ?? {})
      }
    };
  }

  return null;
}

function buildDirectProductUrls(item: Item): string[] {
  const canonical = buildCanonicalGuideName(item.name);

  const slugs = new Set<string>();

  if (canonical) {
    slugs.add(canonical);
  }

  return [...slugs].map((slug) => `${BASE_URL}/game/strategy-guide/${slug}`);
}

function buildQueries(item: Item): string[] {
  const raw = clean(item.name);
  const canonical = buildCanonicalSearchQuery(item);
  const publisher = detectGuidePublisher(item.name, item.platform);

  const queries = new Set<string>();

  if (canonical) {
    queries.add(canonical);
    queries.add(`${canonical} strategy guide`);
    queries.add(`${canonical} official strategy guide`);
    queries.add(`${canonical} official guide`);
    queries.add(`${canonical} guide`);
  }

  if (canonical && publisher && !canonical.includes(publisher)) {
    queries.add(`${canonical} ${publisher}`);
    queries.add(`${canonical} ${publisher} strategy guide`);
    queries.add(`${canonical} ${publisher} official strategy guide`);
  }

  queries.add(raw);

  return [...queries]
    .map((query) => query.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function extractDirectDetail(
  html: string,
  url: string
): Candidate | null {
  const $ = cheerio.load(html);

  const title =
    cleanTitle($("h1").first().text().trim()) ||
    cleanTitle($("meta[property='og:title']").attr("content") || "") ||
    cleanTitle($("title").text().trim()) ||
    titleFromUrl(url);

  const loosePrice =
    parsePriceFromPriceGuideRow($, "Loose") ??
    parsePriceFromLabel(html, "Loose");

  const completePrice =
    parsePriceFromPriceGuideRow($, "Complete") ??
    parsePriceFromLabel(html, "Complete");

  const itemAndManualPrice =
    parsePriceFromPriceGuideRow($, "Item & Manual") ??
    parsePriceFromLabel(html, "Item & Manual");

  const itemAndBoxPrice =
    parsePriceFromPriceGuideRow($, "Item & Box") ??
    parsePriceFromLabel(html, "Item & Box");

  const marketPrice = extractFirstMarketPrice(html);

  const selected = selectBestGuidePrice({
    completePrice,
    itemAndManualPrice,
    itemAndBoxPrice,
    loosePrice,
    marketPrice
  });

  if (!title || !selected.price || selected.price <= 0) {
    return null;
  }

  return {
    title,
    price: selected.price,
    priceKind: selected.priceKind,
    url,
    metadata: {
      loosePrice,
      itemAndBoxPrice,
      itemAndManualPrice,
      completePrice,
      marketPrice,
      selectedPriceKind: selected.priceKind
    }
  };
}

function selectBestGuidePrice(input: {
  completePrice: number | null;
  itemAndManualPrice: number | null;
  itemAndBoxPrice: number | null;
  loosePrice: number | null;
  marketPrice: number | null;
}): { price: number | null; priceKind: PriceKind | undefined } {
  if (input.completePrice && input.completePrice > 0) {
    return { price: input.completePrice, priceKind: "complete" };
  }

  if (input.itemAndManualPrice && input.itemAndManualPrice > 0) {
    return { price: input.itemAndManualPrice, priceKind: "itemAndManual" };
  }

  if (input.itemAndBoxPrice && input.itemAndBoxPrice > 0) {
    return { price: input.itemAndBoxPrice, priceKind: "itemAndBox" };
  }

  if (input.loosePrice && input.loosePrice > 0) {
    return { price: input.loosePrice, priceKind: "loose" };
  }

  if (input.marketPrice && input.marketPrice > 0) {
    return { price: input.marketPrice, priceKind: "market" };
  }

  return { price: null, priceKind: undefined };
}

function extractCandidates(html: string): Candidate[] {
  const $ = cheerio.load(html);
  const candidates: Candidate[] = [];

  $("table#games_table tr").each((_, el) => {
    const row = $(el);

    const link = row.find("td.title a").first();
    const href = link.attr("href") || "";
    const title = cleanTitle(link.text().trim());

    const priceText =
      row.find("td.js-price").first().text().trim() ||
      row.text();

    const price = parsePrice(priceText);

    if (!href || !title || !price) return;

    candidates.push({
      title,
      price,
      priceKind: "market",
      url: absolutize(href)
    });
  });

  $("a[href*='/game/strategy-guide/']").each((_, el) => {
    const link = $(el);
    const href = link.attr("href") || "";

    const title =
      cleanTitle(link.text().trim()) ||
      titleFromUrl(absolutize(href));

    const root = link.closest("tr, li, article, div");

    const priceText =
      root.find(".js-price").first().text().trim() ||
      root.text();

    const price = parsePrice(priceText);

    if (!href || !title || !price) return;

    const url = absolutize(href);

    if (
      candidates.some(
        (candidate) =>
          candidate.url === url ||
          normalizeSearchText(candidate.title) === normalizeSearchText(title)
      )
    ) {
      return;
    }

    candidates.push({
      title,
      price,
      priceKind: "market",
      url
    });
  });

  return candidates;
}

function filterCandidates(
  item: Item,
  candidates: Candidate[]
): Candidate[] {
  return candidates.filter((candidate) => {
    if (!candidate.price || candidate.price <= 0) return false;

    const match = scoreGuideMatch(item, candidate.title);

    if (match.score < MIN_SEARCH_MATCH_SCORE) return false;

    if (!isReliableGuidePrice(item, candidate.price, candidate.priceKind, candidate.title)) {
      return false;
    }

    return true;
  });
}

function pickBestCandidate(
  item: Item,
  candidates: Candidate[]
): Candidate | null {
  if (candidates.length === 0) return null;

  const scored = candidates.map((candidate) => {
    const match = scoreGuideMatch(item, candidate.title);

    let score = match.score;

    if (candidate.priceKind === "complete") score += 0.12;
    if (candidate.priceKind === "itemAndManual") score += 0.08;
    if (candidate.priceKind === "itemAndBox") score += 0.06;
    if (candidate.priceKind === "loose" || candidate.priceKind === "market") score -= 0.04;
    if (candidate.price && candidate.price > 0) score += 0.03;

    return {
      candidate,
      score,
      reasons: match.reasons
    };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log(
    "📘 PriceCharting Guide top:",
    scored.slice(0, 5).map((entry) => ({
      title: entry.candidate.title,
      score: Number(entry.score.toFixed(2)),
      reasons: entry.reasons,
      price: entry.candidate.price,
      priceKind: entry.candidate.priceKind
    }))
  );

  const best = scored[0];

  if (!best || best.score < MIN_SEARCH_MATCH_SCORE) return null;

  return best.candidate;
}

function scoreGuideMatch(
  item: Item,
  matchedTitle: string
): { score: number; reasons: string[] } {
  const wanted = buildCanonicalSearchQuery(item);
  const wantedFull = normalizeSearchText(`${item.name} ${item.platform ?? ""}`);
  const matched = normalizeSearchText(matchedTitle);

  const reasons: string[] = [];
  let score = similarityScore(wanted, matched);

  reasons.push(`similarity:${score.toFixed(2)}`);

  const wantedEdition = extractSagaEdition(wanted || item.name);
  const matchedEdition = extractSagaEdition(matched);

  if (wantedEdition && matchedEdition) {
    if (wantedEdition === matchedEdition) {
      score += 0.22;
      reasons.push("edition-match");
    } else {
      score -= 0.9;
      reasons.push("edition-conflict");
    }
  }

  const publisher = detectGuidePublisher(item.name, item.platform);

  if (publisher) {
    if (matchesPublisher(matched, publisher)) {
      score += 0.2;
      reasons.push("publisher-match");
    } else {
      score -= 0.18;
      reasons.push("publisher-missing");
    }
  }

  if (hasGuideSignal(matched)) {
    score += 0.22;
    reasons.push("guide-signal");
  } else {
    score -= 0.35;
    reasons.push("missing-guide-signal");
  }

  if (hasStrongGuideSignal(matched)) {
    score += 0.14;
    reasons.push("strong-guide-signal");
  }

  const wantedTokens = getCoreGameTokens(wanted);
  const matchedTokens = getCoreGameTokens(matched);

  if (wantedTokens.length > 0) {
    const matches = wantedTokens.filter((token) => matchedTokens.includes(token));
    const ratio = matches.length / wantedTokens.length;

    score += ratio * 0.18;
    reasons.push(`core-token-ratio:${ratio.toFixed(2)}`);

    if (ratio < 0.65) {
      score -= 0.35;
      reasons.push("weak-core-token-match");
    }
  }

  if (matched.includes(wanted)) {
    score += 0.18;
    reasons.push("canonical-in-title");
  }

  if (hasDuplicatedPublisherSignal(matched)) {
    score -= 0.35;
    reasons.push("duplicated-publisher");
  }

  if (hasNonGuideNegativeSignal(matched)) {
    score -= 0.55;
    reasons.push("non-guide-negative");
  }

  if (
    wantedFull.includes("piggyback") &&
    matched.includes("piggyback") &&
    hasStrongGuideSignal(matched)
  ) {
    score += 0.12;
    reasons.push("piggyback-strong-match");
  }

  return { score, reasons };
}

function computeConfidence(
  item: Item,
  matchedTitle: string,
  priceKind?: PriceKind
): number {
  const match = scoreGuideMatch(item, matchedTitle);

  let confidence = 0.35 + match.score * 0.42;

  if (priceKind === "complete") confidence += 0.06;
  if (priceKind === "itemAndManual") confidence += 0.04;
  if (priceKind === "itemAndBox") confidence += 0.03;
  if (priceKind === "loose" || priceKind === "market") confidence -= 0.03;

  if (hasDuplicatedPublisherSignal(normalizeSearchText(matchedTitle))) {
    confidence -= 0.12;
  }

  return Math.max(0.3, Math.min(0.95, Number(confidence.toFixed(2))));
}

function isReliableDirectMatch(
  item: Item,
  matchedTitle: string,
  score: number
): boolean {
  const matched = normalizeSearchText(matchedTitle);

  if (!hasGuideSignal(matched)) return false;
  if (hasNonGuideNegativeSignal(matched)) return false;

  const wanted = buildCanonicalSearchQuery(item);
  const wantedEdition = extractSagaEdition(wanted || item.name);
  const matchedEdition = extractSagaEdition(matched);

  if (
    wantedEdition &&
    matchedEdition &&
    wantedEdition !== matchedEdition
  ) {
    return false;
  }

  return score >= MIN_DIRECT_MATCH_SCORE;
}

function isReliableGuidePrice(
  item: Item,
  price: number | null | undefined,
  priceKind?: PriceKind,
  matchedTitle?: string
): boolean {
  if (typeof price !== "number" || price <= 0) return false;

  const wanted = normalizeSearchText(`${item.name} ${item.platform ?? ""}`);
  const matched = normalizeSearchText(matchedTitle ?? "");

  const hasStructuredPrice =
    priceKind === "complete" ||
    priceKind === "itemAndManual" ||
    priceKind === "itemAndBox";

  const strongGuide = hasStrongGuideSignal(matched);
  const duplicatedPublisher = hasDuplicatedPublisherSignal(matched);

  if (duplicatedPublisher && price < MIN_WEAK_GUIDE_PRICE_USD) {
    return false;
  }

  if (
    wanted.includes("piggyback") &&
    price < MIN_WEAK_GUIDE_PRICE_USD &&
    !hasStructuredPrice &&
    !strongGuide
  ) {
    return false;
  }

  if (
    price < MIN_WEAK_GUIDE_PRICE_USD &&
    !hasStructuredPrice &&
    !strongGuide
  ) {
    return false;
  }

  return true;
}

function hasGuideSignal(value: string): boolean {
  return hasAny(value, [
    "guide",
    "strategy",
    "official",
    "guia",
    "guía",
    "piggyback",
    "bradygames",
    "brady games",
    "future press"
  ]);
}

function hasStrongGuideSignal(value: string): boolean {
  return hasAny(value, [
    "official guide",
    "official strategy guide",
    "strategy guide",
    "guia oficial",
    "guía oficial",
    "guia de estrategia oficial",
    "guía de estrategia oficial",
    "la guia de estrategia oficial",
    "la guía de estrategia oficial"
  ]);
}

function hasDuplicatedPublisherSignal(value: string): boolean {
  return (
    value.includes("piggyback piggyback") ||
    value.includes("bradygames bradygames") ||
    value.includes("brady games brady games") ||
    value.includes("future press future press")
  );
}

function hasNonGuideNegativeSignal(value: string): boolean {
  return hasAny(value, [
    "dvd",
    "blu ray",
    "bluray",
    "advent children",
    "soundtrack",
    "original soundtrack",
    "ost",
    "cd ",
    "novela",
    "manga",
    "lost stranger",
    "arte de",
    "art of",
    "llavero",
    "pin ",
    "figura",
    "juego ",
    "playstation",
    "ps1",
    "ps2",
    "ps3",
    "ps4",
    "ps5",
    "xbox",
    "nintendo ds"
  ]);
}

function matchesPublisher(title: string, publisher: string): boolean {
  if (publisher === "piggyback") return title.includes("piggyback");
  if (publisher === "bradygames") {
    return title.includes("bradygames") || title.includes("brady games");
  }
  if (publisher === "future press") return title.includes("future press");

  return title.includes(publisher);
}

function getCoreGameTokens(value: string): string[] {
  const stopWords = new Set([
    "the",
    "and",
    "of",
    "de",
    "la",
    "el",
    "los",
    "las",
    "official",
    "strategy",
    "guide",
    "guia",
    "guía",
    "oficial",
    "piggyback",
    "bradygames",
    "brady",
    "games",
    "future",
    "press"
  ]);

  return normalizeSearchText(value)
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length > 1)
    .filter((token) => !stopWords.has(token));
}

async function fetchHtml(
  url: string
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!res.ok) return null;

    return await res.text();
  } catch {
    return null;
  }
}

function parsePriceFromPriceGuideRow(
  $: cheerio.CheerioAPI,
  label: string
): number | null {
  let found: number | null = null;

  $("tr").each((_, el) => {
    if (found != null) return;

    const row = $(el);
    const text = row.text().replace(/\s+/g, " ").trim();

    if (!text.toLowerCase().includes(label.toLowerCase())) return;

    found = parsePrice(text);
  });

  return found;
}

function parsePriceFromLabel(
  html: string,
  label: string
): number | null {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const regex = new RegExp(
    `${escapedLabel}\\s*\\$?(\\d{1,6}(?:[.,]\\d{1,2})?)`,
    "i"
  );

  const match = html.replace(/\s+/g, " ").match(regex);

  if (!match?.[1]) return null;

  return parsePrice(match[1]);
}

function extractFirstMarketPrice(html: string): number | null {
  const matches = [
    ...html.matchAll(/\$(\d{1,6}(?:[.,]\d{1,2})?)/g)
  ];

  for (const match of matches) {
    const price = parsePrice(match[1]);

    if (price && price > 0 && price < 10000) {
      return price;
    }
  }

  return null;
}

function parsePrice(text: string): number | null {
  const match = text.match(/\$?\s*(\d{1,6}(?:[.,]\d{1,2})?)/);

  if (!match?.[1]) return null;

  const value = Number(match[1].replace(",", "."));

  return Number.isFinite(value) && value > 0 ? value : null;
}

function buildCanonicalGuideName(name: string): string {
  const canonical = buildCanonicalSearchText(name);

  return canonical
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildCanonicalSearchQuery(item: Item): string {
  return buildCanonicalSearchText(item.name);
}

function buildCanonicalSearchText(value: string): string {
  return normalizeSearchText(value)
    .replace(/\bla guía oficial\b/g, " ")
    .replace(/\bla guia oficial\b/g, " ")
    .replace(/\bofficial strategy guide\b/g, " ")
    .replace(/\bofficial guide\b/g, " ")
    .replace(/\bstrategy guide\b/g, " ")
    .replace(/\bguide\b/g, " ")
    .replace(/\sguía\s/g, " ")
    .replace(/\sguia\s/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectGuidePublisher(
  name: string,
  platform?: string | null
): string | null {
  const text = normalizeSearchText(`${name} ${platform ?? ""}`);

  if (text.includes("piggyback")) return "piggyback";
  if (text.includes("bradygames") || text.includes("brady games")) return "bradygames";
  if (text.includes("future press")) return "future press";

  return null;
}

function extractSagaEdition(value: string): string | null {
  const normalized = normalizeSearchText(value);

  const sequelRoman = normalized.match(/\b([ivxlcdm]{1,6})-(\d+)\b/i);

  if (sequelRoman?.[1] && sequelRoman?.[2]) {
    const roman = romanToNumber(sequelRoman[1]);

    if (roman != null) return `${roman}-${Number(sequelRoman[2])}`;
  }

  const sequelArabic = normalized.match(/\b(\d+)-(\d+)\b/);

  if (sequelArabic?.[1] && sequelArabic?.[2]) {
    return `${Number(sequelArabic[1])}-${Number(sequelArabic[2])}`;
  }

  const roman = normalized.match(/\b[ivxlcdm]{1,6}\b/i);

  if (roman?.[0]) {
    const converted = romanToNumber(roman[0]);

    if (converted != null) return String(converted);
  }

  const arabic = normalized.match(/\b(\d{1,3})\b/);

  if (arabic?.[1]) return String(Number(arabic[1]));

  return null;
}

function romanToNumber(value: string): number | null {
  const roman = value.toLowerCase();

  if (!/^[ivxlcdm]+$/.test(roman)) return null;

  const map: Record<string, number> = {
    i: 1,
    v: 5,
    x: 10,
    l: 50,
    c: 100,
    d: 500,
    m: 1000
  };

  let total = 0;
  let previous = 0;

  for (let i = roman.length - 1; i >= 0; i--) {
    const current = map[roman[i]];

    if (!current) return null;

    if (current < previous) {
      total -= current;
    } else {
      total += current;
    }

    previous = current;
  }

  return total > 0 ? total : null;
}

function normalizeCategory(value: string | null): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
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

function cleanTitle(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\s*prices\s*$/i, "")
    .replace(/\s*pricecharting\s*$/i, "")
    .trim();
}

function hasAny(value: string, tokens: string[]): boolean {
  return tokens.some((token) => value.includes(normalizeSearchText(token)));
}

function absolutize(href: string): string {
  if (href.startsWith("http")) return href;

  return `${BASE_URL}${href}`;
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "";

    return last
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}