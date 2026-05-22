import { Item } from "@prisma/client";
import * as cheerio from "cheerio";

import {
  normalizeText,
  similarityScore
} from "../utils";

import { ScraperSourceResult } from "../scraper.types";

type Candidate = {
  title: string;
  price: number | null;
  url: string;
  metadata?: Record<string, unknown>;
};

type PriceKind =
  | "loose"
  | "complete"
  | "itemAndManual"
  | "itemAndBox";

const BASE_URL = "https://www.pricecharting.com";

const MIN_WEAK_GUIDE_PRICE_USD = 12;

export async function getPriceChartingGuidePrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  console.log("📘 PriceCharting Guide called:", {
    itemId: item.id,
    name: item.name,
    category: item.category
  });

  if (item.category !== "guide") {
    return null;
  }

  const directUrls = buildDirectProductUrls(item);

  for (const directUrl of directUrls) {
    console.log("📘 PriceCharting Guide trying direct:", directUrl);

    const html = await fetchHtml(directUrl);

    if (!html) continue;

    const detail = extractDirectDetail(html, directUrl);

    if (!detail || !detail.price || detail.price <= 0) {
      continue;
    }

    if (!isReliableDirectMatch(item, detail.title)) {
      console.log("📘 PriceCharting Guide direct rejected:", {
        wanted: item.name,
        matchedTitle: detail.title,
        url: directUrl
      });

      continue;
    }

    if (
      !isReliableGuidePrice(
        item,
        detail.price,
        detail.metadata?.priceKind as PriceKind | undefined,
        detail.title
      )
    ) {
      console.log("📘 PriceCharting Guide suspicious direct price:", {
        title: detail.title,
        price: detail.price,
        priceKind: detail.metadata?.priceKind
      });

      continue;
    }

    const confidence = computeConfidence(
      item,
      detail.title
    );

    console.log("📘 PriceCharting Guide direct selected:", {
      title: detail.title,
      price: detail.price,
      confidence,
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
        prices: detail.metadata ?? {}
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
      candidates.map((candidate) => ({
        title: candidate.title,
        price: candidate.price,
        url: candidate.url
      }))
    );

    const filtered = filterCandidates(item, candidates);

    const best = pickBestCandidate(item, filtered);

    if (!best) continue;

    if (
      !isReliableGuidePrice(
        item,
        best.price,
        best.metadata?.priceKind as PriceKind | undefined,
        best.title
      )
    ) {
      console.log("📘 PriceCharting Guide suspicious search price:", {
        title: best.title,
        price: best.price,
        priceKind: best.metadata?.priceKind
      });

      continue;
    }

    const confidence = computeConfidence(
      item,
      best.title
    );

    console.log("📘 PriceCharting Guide selected:", {
      title: best.title,
      price: best.price,
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
        ...(best.metadata ?? {})
      }
    };
  }

  return null;
}

function buildDirectProductUrls(item: Item): string[] {
  const canonical = buildCanonicalGuideName(item.name);
  const publisher = detectGuidePublisher(item.name, item.platform);

  const slugs = new Set<string>();

  if (canonical) {
    if (publisher) {
      slugs.add(`${canonical}-${publisher}`);
    }

    slugs.add(canonical);
  }

  return [...slugs]
    .map((slug) => `${BASE_URL}/game/strategy-guide/${slug}`);
}

function buildQueries(item: Item): string[] {
  const raw = clean(item.name);
  const canonical = buildCanonicalSearchQuery(item);
  const publisher = detectGuidePublisher(item.name, item.platform);

  const queries = new Set<string>();

  if (canonical && publisher) {
    queries.add(`${canonical} ${publisher}`);
    queries.add(`${canonical} strategy guide`);
    queries.add(`${canonical} official strategy guide`);
    queries.add(`${canonical} guide`);
  }

  if (canonical) {
    queries.add(`${canonical} strategy guide`);
    queries.add(`${canonical} official strategy guide`);
    queries.add(`${canonical} official guide`);
    queries.add(`${canonical} guide`);
    queries.add(canonical);
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

  let price: number | null = null;
  let priceKind: PriceKind | undefined;

  if (completePrice) {
    price = completePrice;
    priceKind = "complete";
  } else if (itemAndManualPrice) {
    price = itemAndManualPrice;
    priceKind = "itemAndManual";
  } else if (itemAndBoxPrice) {
    price = itemAndBoxPrice;
    priceKind = "itemAndBox";
  } else if (loosePrice) {
    price = loosePrice;
    priceKind = "loose";
  } else {
    price = extractFirstMarketPrice(html);
  }

  if (!title || !price || price <= 0) {
    return null;
  }

  return {
    title,
    price,
    url,
    metadata: {
      loosePrice,
      itemAndBoxPrice,
      itemAndManualPrice,
      completePrice,
      priceKind
    }
  };
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

    if (!href || !title || !price) {
      return;
    }

    candidates.push({
      title,
      price,
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

    const completePrice = parsePrice(
      root.find(".complete_price").text().trim()
    );

    const loosePrice = parsePrice(
      root.find(".js-price").first().text().trim() ||
      root.text()
    );

    const price =
      completePrice ??
      loosePrice;

    if (!href || !title || !price) {
      return;
    }

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
      url,
      metadata: {
        priceKind: completePrice
          ? "complete"
          : "loose"
      }
    });
  });

  return candidates;
}

function filterCandidates(
  item: Item,
  candidates: Candidate[]
): Candidate[] {
  const wanted = buildCanonicalSearchQuery(item);
  const publisher = detectGuidePublisher(item.name, item.platform);
  const wantedEdition = extractSagaEdition(wanted || item.name);

  const tokens = wanted
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length > 1);

  if (tokens.length === 0) return [];

  return candidates.filter((candidate) => {
    const title = normalizeSearchText(candidate.title);
    const candidateEdition = extractSagaEdition(title);

    if (
      wantedEdition &&
      candidateEdition &&
      wantedEdition !== candidateEdition
    ) {
      return false;
    }

    const matches = tokens.filter((token) =>
      title.includes(token)
    );

    const ratio = matches.length / tokens.length;

    if (ratio < 0.45) {
      return false;
    }

    const hasGuideSignal =
      hasAny(title, [
        "guide",
        "strategy",
        "piggyback",
        "bradygames",
        "brady games",
        "future press",
        "guia",
        "guía"
      ]);

    if (!hasGuideSignal) {
      return false;
    }

    if (
      publisher &&
      !title.includes(publisher) &&
      ratio < 0.75
    ) {
      return false;
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

  const wanted = buildCanonicalSearchQuery(item);
  const publisher = detectGuidePublisher(item.name, item.platform);
  const wantedEdition = extractSagaEdition(wanted || item.name);

  const scored = candidates.map((candidate) => {
    const title = normalizeSearchText(candidate.title);
    const candidateEdition = extractSagaEdition(title);

    let score = similarityScore(wanted, title);

    if (title.includes(wanted)) {
      score += 0.25;
    }

    if (
      wantedEdition &&
      candidateEdition &&
      wantedEdition === candidateEdition
    ) {
      score += 0.25;
    }

    if (publisher && title.includes(publisher)) {
      score += 0.2;
    }

    if (
      hasAny(title, [
        "official guide",
        "official strategy guide",
        "strategy guide",
        "piggyback",
        "bradygames",
        "future press",
        "guia oficial",
        "guía oficial"
      ])
    ) {
      score += 0.2;
    }

    if (candidate.price && candidate.price > 0) {
      score += 0.05;
    }

    return {
      candidate,
      score
    };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log(
    "📘 PriceCharting Guide top:",
    scored.slice(0, 5).map((entry) => ({
      title: entry.candidate.title,
      score: Number(entry.score.toFixed(2)),
      price: entry.candidate.price
    }))
  );

  const best = scored[0];

  if (!best || best.score < 0.5) {
    return null;
  }

  return best.candidate;
}

function computeConfidence(
  item: Item,
  matchedTitle: string
): number {
  const wanted = buildCanonicalSearchQuery(item);
  const matched = normalizeSearchText(matchedTitle);

  const publisher = detectGuidePublisher(item.name, item.platform);
  const wantedEdition = extractSagaEdition(wanted || item.name);
  const matchedEdition = extractSagaEdition(matched);

  let confidence =
    0.48 +
    similarityScore(wanted, matched) * 0.32;

  if (matched.includes(wanted)) {
    confidence += 0.08;
  }

  if (
    wantedEdition &&
    matchedEdition &&
    wantedEdition === matchedEdition
  ) {
    confidence += 0.1;
  }

  if (publisher && matched.includes(publisher)) {
    confidence += 0.08;
  }

  if (
    hasAny(matched, [
      "official guide",
      "official strategy guide",
      "strategy guide",
      "piggyback",
      "bradygames",
      "future press",
      "guia oficial",
      "guía oficial"
    ])
  ) {
    confidence += 0.08;
  }

  return Math.max(
    0.3,
    Math.min(
      0.95,
      Number(confidence.toFixed(2))
    )
  );
}

function isReliableDirectMatch(
  item: Item,
  matchedTitle: string
): boolean {
  const wanted = buildCanonicalSearchQuery(item);
  const matched = normalizeSearchText(matchedTitle);

  const wantedEdition = extractSagaEdition(wanted || item.name);
  const matchedEdition = extractSagaEdition(matched);

  if (
    wantedEdition &&
    matchedEdition &&
    wantedEdition !== matchedEdition
  ) {
    return false;
  }

  if (
    !hasAny(matched, [
      "guide",
      "strategy",
      "piggyback",
      "bradygames",
      "future press",
      "guia",
      "guía"
    ])
  ) {
    return false;
  }

  return (
    similarityScore(wanted, matched) >= 0.4 ||
    matched.includes(wanted)
  );
}

function isReliableGuidePrice(
  item: Item,
  price: number | null | undefined,
  priceKind?: PriceKind,
  matchedTitle?: string
): boolean {
  if (typeof price !== "number" || price <= 0) {
    return false;
  }

  const matched = normalizeSearchText(matchedTitle ?? "");

  const hasStructuredPrice =
    priceKind === "complete" ||
    priceKind === "itemAndManual" ||
    priceKind === "itemAndBox";

  const hasStrongGuideSignal =
    matched.includes("official strategy guide") ||
    matched.includes("strategy guide") ||
    matched.includes("guia oficial") ||
    matched.includes("guía oficial") ||
    matched.includes("piggyback") ||
    matched.includes("bradygames") ||
    matched.includes("future press");

  const hasDuplicatedPublisher =
    matched.includes("piggyback piggyback") ||
    matched.includes("bradygames bradygames") ||
    matched.includes("future press future press");

  if (
    hasDuplicatedPublisher &&
    price < MIN_WEAK_GUIDE_PRICE_USD
  ) {
    return false;
  }

  const isSuspiciousLowPrice =
    price < MIN_WEAK_GUIDE_PRICE_USD &&
    !hasStructuredPrice &&
    !hasStrongGuideSignal;

  if (isSuspiciousLowPrice) {
    return false;
  }

  return true;
}

async function fetchHtml(
  url: string
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0"
      }
    });

    if (!res.ok) {
      return null;
    }

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

    if (!text.toLowerCase().includes(label.toLowerCase())) {
      return;
    }

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

  if (!match?.[1]) {
    return null;
  }

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

function parsePrice(
  text: string
): number | null {
  const match =
    text.match(/\$?\s*(\d{1,6}(?:[.,]\d{1,2})?)/);

  if (!match?.[1]) {
    return null;
  }

  const value = Number(
    match[1].replace(",", ".")
  );

  return Number.isFinite(value) && value > 0
    ? value
    : null;
}

function buildCanonicalGuideName(name: string): string {
  const canonical = buildCanonicalSearchText(name);

  return canonical
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildCanonicalSearchQuery(item: Item): string {
  const base = buildCanonicalSearchText(item.name);

  return base;
}

function buildCanonicalSearchText(value: string): string {
  return normalizeSearchText(value)
    .replace(/\bla guía oficial\b/g, " ")
    .replace(/\bla guia oficial\b/g, " ")
    .replace(/\bofficial strategy guide\b/g, " ")
    .replace(/\bstrategy guide\b/g, " ")
    .replace(/\bofficial guide\b/g, " ")
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

  if (text.includes("piggyback")) {
    return "piggyback";
  }

  if (
    text.includes("bradygames") ||
    text.includes("brady games")
  ) {
    return "bradygames";
  }

  if (text.includes("future press")) {
    return "future press";
  }

  return null;
}

function extractSagaEdition(value: string): string | null {
  const normalized = normalizeSearchText(value);

  const sequelRoman = normalized.match(
    /\b([ivxlcdm]{1,6})-(\d+)\b/i
  );

  if (sequelRoman?.[1] && sequelRoman?.[2]) {
    const roman = romanToNumber(sequelRoman[1]);

    if (roman != null) {
      return `${roman}-${Number(sequelRoman[2])}`;
    }
  }

  const sequelArabic = normalized.match(
    /\b(\d+)-(\d+)\b/
  );

  if (sequelArabic?.[1] && sequelArabic?.[2]) {
    return `${Number(sequelArabic[1])}-${Number(sequelArabic[2])}`;
  }

  const roman = normalized.match(
    /\b[ivxlcdm]{1,6}\b/i
  );

  if (roman?.[0]) {
    const converted = romanToNumber(roman[0]);

    if (converted != null) {
      return String(converted);
    }
  }

  const arabic = normalized.match(
    /\b(\d{1,3})\b/
  );

  if (arabic?.[1]) {
    return String(Number(arabic[1]));
  }

  return null;
}

function romanToNumber(value: string): number | null {
  const roman = value.toLowerCase();

  if (!/^[ivxlcdm]+$/.test(roman)) {
    return null;
  }

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

    if (!current) {
      return null;
    }

    if (current < previous) {
      total -= current;
    } else {
      total += current;
    }

    previous = current;
  }

  return total > 0 ? total : null;
}

function normalizeSearchText(
  value: string
): string {
  return normalizeText(value)
    .replace(/\s+/g, " ")
    .trim();
}

function clean(
  value: string
): string {
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

function hasAny(
  value: string,
  tokens: string[]
): boolean {
  return tokens.some((token) =>
    value.includes(token)
  );
}

function absolutize(
  href: string
): string {
  if (href.startsWith("http")) {
    return href;
  }

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