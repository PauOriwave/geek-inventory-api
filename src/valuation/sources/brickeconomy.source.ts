import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import { normalizeText, parseEuroPrice, similarityScore } from "../utils";
import { ScraperSourceResult } from "../scraper.types";

type SetCandidate = {
  title: string;
  setNumber: string;
  url: string;
  score: number;
  source: "direct" | "known_alias" | "brickeconomy" | "bricklink";
};

type BrickEconomyMetrics = {
  setNumber: string;
  currency: "EUR" | "USD" | "GBP" | null;
  marketValue: number | null;
  retailPrice: number | null;
  newSealedValue: number | null;
  newSealedMin: number | null;
  newSealedMax: number | null;
  usedValue: number | null;
  usedMin: number | null;
  usedMax: number | null;
  priceBasis: string;
};

type BrickEconomyDetail = {
  title: string;
  price: number;
  url: string;
  metrics: BrickEconomyMetrics;
};

const BRICKLINK_BASE_URL = "https://www.bricklink.com";
const BRICKECONOMY_BASE_URL = "https://www.brickeconomy.com";
const REQUEST_TIMEOUT_MS = 15000;

export async function getBrickEconomyPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  console.log("🧱 BE called:", {
    itemId: item.id,
    name: item.name,
    category: item.category
  });

  if (item.category !== "lego") return null;

  const query = String(item.name || "").trim();
  if (!query) return null;

  const setMatch = await resolveLegoSet(item);

  console.log("🧱 BE resolved set:", {
    query,
    setNumber: setMatch?.setNumber ?? null,
    title: setMatch?.title ?? null,
    source: setMatch?.source ?? null,
    score: setMatch?.score ?? null,
    url: setMatch?.url ?? null
  });

  if (!setMatch?.setNumber) {
    console.log("🧱 BE no set number resolved:", query);
    return null;
  }

  const urls = buildBrickEconomyUrls(setMatch);

  for (const url of urls) {
    console.log("🧱 BE Detail:", url);

    const detail = await fetchBrickEconomyDetail(url, setMatch.setNumber);

    if (!detail) continue;

    const confidence = computeConfidence({
      item,
      detail,
      setMatch
    });

    console.log("🧱 BE selected:", {
      setNumber: setMatch.setNumber,
      title: detail.title,
      price: detail.price,
      confidence,
      url: detail.url,
      metrics: detail.metrics
    });

    return {
      price: Number(detail.price.toFixed(2)),
      source: "brickeconomy",
      confidence,
      matchedTitle: detail.title,
      matchedUrl: detail.url,
      query,
      metadata: {
        ...detail.metrics,
        resolverSource: setMatch.source,
        resolverScore: setMatch.score,
        brickEconomyUrl: detail.url
      }
    };
  }

  return null;
}

async function resolveLegoSet(item: Item): Promise<SetCandidate | null> {
  const directSetNumber = extractSetNumber(item.name);

  if (directSetNumber) {
    return {
      title: item.name,
      setNumber: directSetNumber,
      url: `${BRICKECONOMY_BASE_URL}/set/${directSetNumber}-1`,
      score: 1,
      source: "direct"
    };
  }

  const knownAlias = resolveKnownLegoAlias(item.name);
  if (knownAlias) return knownAlias;

  const brickEconomyMatch = await resolveFromBrickEconomyThemeSearch(item);
  if (brickEconomyMatch) return brickEconomyMatch;

  const brickLinkMatch = await resolveFromBrickLinkSearch(item);
  if (brickLinkMatch) return brickLinkMatch;

  return null;
}

function resolveKnownLegoAlias(value: string): SetCandidate | null {
  const normalized = normalizeLegoText(value);

  const aliases: Array<{
    tokens: string[];
    setNumber: string;
    title: string;
    slug: string;
  }> = [
    {
      tokens: ["lone", "ranger", "comanche", "camp"],
      setNumber: "79107",
      title: "LEGO The Lone Ranger Comanche Camp",
      slug: "lego-the-lone-ranger-comanche-camp"
    }
  ];

  for (const alias of aliases) {
    const matches = alias.tokens.every((token) => normalized.includes(token));

    if (!matches) continue;

    return {
      title: alias.title,
      setNumber: alias.setNumber,
      url: `${BRICKECONOMY_BASE_URL}/set/${alias.setNumber}-1/${alias.slug}`,
      score: 1,
      source: "known_alias"
    };
  }

  return null;
}

async function resolveFromBrickEconomyThemeSearch(
  item: Item
): Promise<SetCandidate | null> {
  const urls = buildBrickEconomyThemeUrls(item.name);

  for (const url of urls) {
    console.log("🧱 BE Theme Search:", url);

    const html = await fetchHtml(url, BRICKECONOMY_BASE_URL);
    if (!html) continue;

    const candidates = extractBrickEconomyCandidates(html);

    console.log("🧱 BE theme candidates:", candidates.length);

    const best = pickBestSetCandidate(item, candidates, "brickeconomy");

    if (best) return best;
  }

  return null;
}

async function resolveFromBrickLinkSearch(
  item: Item
): Promise<SetCandidate | null> {
  const query = cleanLegoQuery(item.name);
  if (!query) return null;

  const urls = [
    `${BRICKLINK_BASE_URL}/v2/search.page?q=${encodeURIComponent(query)}`,
    `${BRICKLINK_BASE_URL}/catalogList.asp?q=${encodeURIComponent(query)}`
  ];

  for (const url of urls) {
    console.log("🧱 BL Searching:", url);

    const html = await fetchHtml(url, BRICKLINK_BASE_URL);
    if (!html) continue;

    const candidates = extractBrickLinkCandidates(html);

    console.log("🧱 BL candidates:", candidates.length);

    const best = pickBestSetCandidate(item, candidates, "bricklink");

    if (best) return best;
  }

  return null;
}

function buildBrickEconomyThemeUrls(value: string): string[] {
  const normalized = normalizeLegoText(value);
  const urls: string[] = [];

  if (normalized.includes("lone ranger")) {
    urls.push(`${BRICKECONOMY_BASE_URL}/sets/theme/the-lone-ranger`);
    urls.push(`${BRICKECONOMY_BASE_URL}/sets/year/2013/theme/the-lone-ranger`);
  }

  if (normalized.includes("star wars")) urls.push(`${BRICKECONOMY_BASE_URL}/sets/theme/star-wars`);
  if (normalized.includes("indiana jones")) urls.push(`${BRICKECONOMY_BASE_URL}/sets/theme/indiana-jones`);
  if (normalized.includes("harry potter")) urls.push(`${BRICKECONOMY_BASE_URL}/sets/theme/harry-potter`);
  if (normalized.includes("technic")) urls.push(`${BRICKECONOMY_BASE_URL}/sets/theme/technic`);
  if (normalized.includes("ideas")) urls.push(`${BRICKECONOMY_BASE_URL}/sets/theme/ideas`);
  if (normalized.includes("architecture")) urls.push(`${BRICKECONOMY_BASE_URL}/sets/theme/architecture`);
  if (normalized.includes("city")) urls.push(`${BRICKECONOMY_BASE_URL}/sets/theme/city`);
  if (normalized.includes("ninjago")) urls.push(`${BRICKECONOMY_BASE_URL}/sets/theme/ninjago`);
  if (normalized.includes("friends")) urls.push(`${BRICKECONOMY_BASE_URL}/sets/theme/friends`);
  if (normalized.includes("classic")) urls.push(`${BRICKECONOMY_BASE_URL}/sets/theme/classic`);
  if (normalized.includes("creator")) urls.push(`${BRICKECONOMY_BASE_URL}/sets/theme/creator`);

  return [...new Set(urls)];
}

function extractBrickEconomyCandidates(html: string): SetCandidate[] {
  const $ = cheerio.load(html);
  const candidates: SetCandidate[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_, el) => {
    const link = $(el);
    const href = decodeHtml(link.attr("href") || "");
    const url = absolutizeBrickEconomy(href);

    const setNumber = extractSetNumberFromBrickEconomyUrl(url);
    if (!setNumber) return;

    const root = link.closest("article, li, div, tr, section");

    const title =
      cleanTitle(link.text()) ||
      cleanTitle(link.attr("title") || "") ||
      cleanTitle(root.find("h1, h2, h3, h4").first().text()) ||
      cleanTitle(root.text()) ||
      titleFromUrl(url) ||
      `LEGO ${setNumber}`;

    addSetCandidate(candidates, seen, {
      title,
      setNumber,
      url,
      score: 0,
      source: "brickeconomy"
    });
  });

  extractRawBrickEconomyUrls(html).forEach((url) => {
    const setNumber = extractSetNumberFromBrickEconomyUrl(url);
    if (!setNumber) return;

    addSetCandidate(candidates, seen, {
      title: titleFromUrl(url) || `LEGO ${setNumber}`,
      setNumber,
      url,
      score: 0,
      source: "brickeconomy"
    });
  });

  return candidates;
}

function extractBrickLinkCandidates(html: string): SetCandidate[] {
  const $ = cheerio.load(html);
  const candidates: SetCandidate[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_, el) => {
    const link = $(el);
    const href = decodeHtml(link.attr("href") || "");
    const url = absolutizeBrickLink(href);

    const setNumber = extractSetNumberFromBrickLinkUrl(url);
    if (!setNumber) return;

    const root = link.closest("article, li, div, tr, section");

    const title =
      cleanTitle(link.text()) ||
      cleanTitle(link.attr("title") || "") ||
      cleanTitle(root.find("h1, h2, h3, h4").first().text()) ||
      cleanTitle(root.text()) ||
      titleFromUrl(url) ||
      `LEGO ${setNumber}`;

    addSetCandidate(candidates, seen, {
      title,
      setNumber,
      url,
      score: 0,
      source: "bricklink"
    });
  });

  extractRawBrickLinkCatalogUrls(html).forEach((url) => {
    const setNumber = extractSetNumberFromBrickLinkUrl(url);
    if (!setNumber) return;

    addSetCandidate(candidates, seen, {
      title: titleFromUrl(url) || `LEGO ${setNumber}`,
      setNumber,
      url,
      score: 0,
      source: "bricklink"
    });
  });

  return candidates;
}

function pickBestSetCandidate(
  item: Item,
  candidates: SetCandidate[],
  forcedSource: SetCandidate["source"]
): SetCandidate | null {
  const wanted = normalizeLegoText(item.name);
  const wantedTokens = getImportantTokens(wanted);
  const wantedSetNumber = extractSetNumber(item.name);

  const scored = candidates.map((candidate) => {
    const title = normalizeLegoText(candidate.title);
    const url = normalizeLegoText(candidate.url);

    let score = similarityScore(wanted, title);

    if (wantedSetNumber && candidate.setNumber === wantedSetNumber) score += 1;
    if (title.includes(wanted)) score += 0.35;
    if (wanted.includes(title)) score += 0.15;
    if (url.includes(wanted.replace(/\s+/g, "-"))) score += 0.25;

    const matchedImportantTokens = wantedTokens.filter(
      (token) => title.includes(token) || url.includes(token)
    );

    if (wantedTokens.length > 0) {
      score += (matchedImportantTokens.length / wantedTokens.length) * 0.45;
    }

    if (candidate.url.includes("brickeconomy.com/set/")) score += 0.15;
    if (candidate.url.includes("bricklink.com")) score += 0.05;

    return {
      ...candidate,
      source: forcedSource,
      score: Number(score.toFixed(4))
    };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log(
    "🧱 set resolver top:",
    scored.slice(0, 8).map((candidate) => ({
      setNumber: candidate.setNumber,
      title: candidate.title,
      score: Number(candidate.score.toFixed(2)),
      source: candidate.source,
      url: candidate.url
    }))
  );

  const best = scored[0];

  if (!best) return null;
  if (best.score < 0.42) return null;

  return {
    ...best,
    score: Number(Math.min(1, best.score).toFixed(2))
  };
}

function addSetCandidate(
  candidates: SetCandidate[],
  seen: Set<string>,
  candidate: SetCandidate
) {
  if (!candidate.setNumber || !candidate.url) return;

  const key = `${candidate.setNumber}|${normalizeText(candidate.title)}|${candidate.url}`;

  if (seen.has(key)) return;
  seen.add(key);

  candidates.push(candidate);
}

function buildBrickEconomyUrls(setMatch: SetCandidate): string[] {
  return [
    setMatch.url,
    `${BRICKECONOMY_BASE_URL}/set/${setMatch.setNumber}-1`,
    `${BRICKECONOMY_BASE_URL}/set/${setMatch.setNumber}`
  ].filter(Boolean);
}

async function fetchBrickEconomyDetail(
  url: string,
  setNumber: string
): Promise<BrickEconomyDetail | null> {
  const html = await fetchHtml(url, BRICKECONOMY_BASE_URL);
  if (!html) return null;

  const $ = cheerio.load(html);

  const title = extractBrickEconomyTitle($, url);
  const metrics = extractBrickEconomyMetrics($, html, setNumber, url);

  console.log("🧱 BE detail parsed:", {
    url,
    title,
    metrics
  });

  if (!metrics.marketValue && !metrics.retailPrice && !metrics.newSealedValue && !metrics.usedValue) {
    return null;
  }

  return {
    title,
    price: selectPrimaryPrice(metrics),
    url,
    metrics
  };
}

async function fetchHtml(
  url: string,
  referer: string
): Promise<string | null> {
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
        Referer: referer
      }
    });

    if (!res.ok) {
      console.log("❌ fetch failed:", {
        status: res.status,
        url
      });

      return null;
    }

    return await res.text();
  } catch (err) {
    console.log("❌ fetch error:", {
      url,
      error: err
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractBrickEconomyTitle(
  $: cheerio.CheerioAPI,
  url: string
): string {
  return cleanTitle(
    $("h1").first().text().trim() ||
      $("meta[property='og:title']").attr("content")?.trim() ||
      $("[itemprop='name']").first().text().trim() ||
      titleFromUrl(url) ||
      "LEGO set"
  );
}

function extractBrickEconomyMetrics(
  $: cheerio.CheerioAPI,
  html: string,
  setNumber: string,
  url: string
): BrickEconomyMetrics {
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const normalizedBody = normalizeText(bodyText);
  const currency = detectCurrency(bodyText);

  console.log("🧱 BE price page hints:", {
    hasValue: normalizedBody.includes("value"),
    hasRetail: normalizedBody.includes("retail"),
    hasNewSealed: normalizedBody.includes("new") && normalizedBody.includes("sealed"),
    hasUsed: normalizedBody.includes("used"),
    hasGrowth: normalizedBody.includes("growth"),
    currencySamples: extractCurrencySamples(bodyText).slice(0, 20)
  });

  const marketValue =
    extractPriceAfterLabel(bodyText, ["Market Value", "Current Value", "Value"]) ??
    extractPriceNearLabelFromDom($, ["Market Value", "Current Value", "Value"]);

  const retailPrice =
    extractPriceAfterLabel(bodyText, ["Retail Price", "Retail", "RRP", "MSRP"]) ??
    extractPriceNearLabelFromDom($, ["Retail Price", "Retail", "RRP", "MSRP"]);

  const newSealedRange = extractRangeAfterLabel(bodyText, [
    "New and Sealed",
    "New/Sealed",
    "Sealed"
  ]);

  const newSealedSingle = extractPriceAfterLabel(bodyText, [
    "New and Sealed",
    "New/Sealed",
    "Sealed"
  ]);

  const usedRange = extractRangeAfterLabel(bodyText, [
    "Used Value",
    "Used Price",
    "Used"
  ]);

  const usedSingle = extractPriceAfterLabel(bodyText, [
    "Used Value",
    "Used Price",
    "Used"
  ]);

  const jsonMetrics = extractMetricsFromJson(html);

  const metrics: BrickEconomyMetrics = {
    setNumber,
    currency,
    marketValue: marketValue ?? jsonMetrics.marketValue ?? null,
    retailPrice: retailPrice ?? jsonMetrics.retailPrice ?? null,
    newSealedValue:
      newSealedSingle ??
      averageRange(newSealedRange.min, newSealedRange.max) ??
      jsonMetrics.newSealedValue ??
      null,
    newSealedMin: newSealedRange.min ?? jsonMetrics.newSealedMin ?? null,
    newSealedMax: newSealedRange.max ?? jsonMetrics.newSealedMax ?? null,
    usedValue:
      usedSingle ??
      averageRange(usedRange.min, usedRange.max) ??
      jsonMetrics.usedValue ??
      null,
    usedMin: usedRange.min ?? jsonMetrics.usedMin ?? null,
    usedMax: usedRange.max ?? jsonMetrics.usedMax ?? null,
    priceBasis: "unknown"
  };

  metrics.priceBasis = selectPriceBasis(metrics);

  console.log("🧱 BE metrics extracted:", {
    url,
    metrics
  });

  return metrics;
}

function selectPrimaryPrice(metrics: BrickEconomyMetrics): number {
  return (
    metrics.marketValue ??
    metrics.newSealedValue ??
    metrics.retailPrice ??
    metrics.usedValue ??
    0
  );
}

function selectPriceBasis(metrics: BrickEconomyMetrics): string {
  if (metrics.marketValue) return "marketValue";
  if (metrics.newSealedValue) return "newSealedValue";
  if (metrics.retailPrice) return "retailPrice";
  if (metrics.usedValue) return "usedValue";
  return "unknown";
}

function extractPriceAfterLabel(
  text: string,
  labels: string[]
): number | null {
  for (const label of labels) {
    const escapedLabel = escapeRegExp(label);

    const patterns = [
      new RegExp(
        `\\b${escapedLabel}\\b\\s*[:\\-]?\\s*[€$£]\\s*(\\d{1,6}(?:[.,]\\d{1,2})?)`,
        "i"
      ),
      new RegExp(
        `\\b${escapedLabel}\\b\\s*[:\\-]?\\s*(\\d{1,6}(?:[.,]\\d{1,2})?)\\s*[€$£]`,
        "i"
      ),
      new RegExp(
        `\\b${escapedLabel}\\b.{0,80}?[€$£]\\s*(\\d{1,6}(?:[.,]\\d{1,2})?)`,
        "i"
      ),
      new RegExp(
        `\\b${escapedLabel}\\b.{0,80}?(\\d{1,6}(?:[.,]\\d{1,2})?)\\s*[€$£]`,
        "i"
      )
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match) continue;

      const context = getMatchContext(text, match.index ?? 0, 120);

      if (isBadPriceContext(context)) continue;

      const parsed = parsePrice(match[1]);

      if (parsed && isUsableLegoPrice(parsed)) return parsed;
    }
  }

  return null;
}

function extractRangeAfterLabel(
  text: string,
  labels: string[]
): { min: number | null; max: number | null } {
  for (const label of labels) {
    const escapedLabel = escapeRegExp(label);

    const patterns = [
      new RegExp(
        `\\b${escapedLabel}\\b[^.]{0,220}?between\\s*[€$£]\\s*(\\d{1,6}(?:[.,]\\d{1,2})?)\\s+and\\s*[€$£]\\s*(\\d{1,6}(?:[.,]\\d{1,2})?)`,
        "i"
      ),
      new RegExp(
        `\\b${escapedLabel}\\b[^.]{0,220}?[€$£]\\s*(\\d{1,6}(?:[.,]\\d{1,2})?)\\s*(?:-|to|and)\\s*[€$£]\\s*(\\d{1,6}(?:[.,]\\d{1,2})?)`,
        "i"
      )
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match) continue;

      const context = getMatchContext(text, match.index ?? 0, 260);

      if (isBadPriceContext(context)) continue;

      const min = parsePrice(match[1]);
      const max = parsePrice(match[2]);

      if (min && max && isUsableLegoPrice(min) && isUsableLegoPrice(max)) {
        return { min, max };
      }
    }
  }

  return { min: null, max: null };
}

function extractPriceNearLabelFromDom(
  $: cheerio.CheerioAPI,
  labels: string[]
): number | null {
  const labelMatchers = labels.map((label) => normalizeText(label));

  const candidates: number[] = [];

  $("body *").each((_, el) => {
    const node = $(el);
    const text = node.text().replace(/\s+/g, " ").trim();

    if (!text || text.length > 500) return;

    const normalized = normalizeText(text);
    const hasLabel = labelMatchers.some((label) => normalized.includes(label));

    if (!hasLabel) return;
    if (isBadPriceContext(text)) return;

    const price = extractFirstCurrencyPrice(text);

    if (price && isUsableLegoPrice(price)) {
      candidates.push(price);
    }
  });

  return candidates[0] ?? null;
}

function extractMetricsFromJson(html: string): Partial<BrickEconomyMetrics> {
  return {
    marketValue: extractJsonPrice(html, [
      "marketValue",
      "currentValue",
      "setValue"
    ]),
    retailPrice: extractJsonPrice(html, [
      "retailPrice",
      "msrp"
    ]),
    newSealedValue: extractJsonPrice(html, [
      "newSealedValue",
      "sealedValue",
      "newValue"
    ]),
    newSealedMin: extractJsonPrice(html, [
      "newSealedMin",
      "sealedMin",
      "newMin"
    ]),
    newSealedMax: extractJsonPrice(html, [
      "newSealedMax",
      "sealedMax",
      "newMax"
    ]),
    usedValue: extractJsonPrice(html, [
      "usedValue",
      "usedPrice"
    ]),
    usedMin: extractJsonPrice(html, [
      "usedMin"
    ]),
    usedMax: extractJsonPrice(html, [
      "usedMax"
    ])
  };
}

function extractJsonPrice(html: string, keys: string[]): number | null {
  for (const key of keys) {
    const pattern = new RegExp(
      `"${escapeRegExp(key)}"\\s*:\\s*"?(${String.raw`\d{1,6}(?:[.,]\d{1,2})?`})"?`,
      "gi"
    );

    for (const match of html.matchAll(pattern)) {
      const parsed = parsePrice(match[1]);

      if (parsed && isUsableLegoPrice(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function detectCurrency(text: string): "EUR" | "USD" | "GBP" | null {
  if (text.includes("€")) return "EUR";
  if (text.includes("$")) return "USD";
  if (text.includes("£")) return "GBP";
  return null;
}

function averageRange(
  min: number | null,
  max: number | null
): number | null {
  if (!min || !max) return null;
  return Number(((min + max) / 2).toFixed(2));
}

function extractCurrencySamples(text: string): string[] {
  return [...text.matchAll(/[€$£]\s*\d{1,6}(?:[.,]\d{1,2})?/g)]
    .map((match) => match[0])
    .slice(0, 50);
}

function extractFirstCurrencyPrice(text: string): number | null {
  const match = text.match(/[€$£]\s*(\d{1,6}(?:[.,]\d{1,2})?)/);

  if (!match) {
    const reverseMatch = text.match(/(\d{1,6}(?:[.,]\d{1,2})?)\s*[€$£]/);
    return parsePrice(reverseMatch?.[1]);
  }

  return parsePrice(match[1]);
}

function getMatchContext(text: string, index: number, size: number): string {
  return text.slice(Math.max(0, index - size), index + size);
}

function isBadPriceContext(value: string): boolean {
  const normalized = normalizeText(value);

  const badTokens = [
    "growth",
    "annual growth",
    "yearly growth",
    "roi",
    "return",
    "change",
    "trend",
    "forecast",
    "prediction",
    "predicted",
    "increase",
    "decrease",
    "percent",
    "percentage",
    "pieces",
    "minifig",
    "minifigure",
    "shipping",
    "delivery"
  ];

  return badTokens.some((token) => normalized.includes(token));
}

function isUsableLegoPrice(value: number): boolean {
  return Number.isFinite(value) && value >= 8 && value <= 10000;
}

function computeConfidence(input: {
  item: Item;
  detail: BrickEconomyDetail;
  setMatch: SetCandidate;
}): number {
  const wanted = normalizeLegoText(input.item.name);
  const matched = normalizeLegoText(input.detail.title);

  let confidence = 0.55;

  confidence += similarityScore(wanted, matched) * 0.25;
  confidence += input.setMatch.score * 0.2;

  if (input.setMatch.source === "direct") confidence += 0.25;
  if (input.setMatch.source === "known_alias") confidence += 0.22;
  if (input.setMatch.source === "brickeconomy") confidence += 0.15;
  if (input.setMatch.source === "bricklink") confidence += 0.08;

  if (normalizeText(input.detail.title).includes(input.setMatch.setNumber)) {
    confidence += 0.1;
  }

  return Math.max(0.5, Math.min(0.95, Number(confidence.toFixed(2))));
}

function extractSetNumber(value: string): string | null {
  const patterns = [
    /\blego\s+(\d{4,7})\b/i,
    /\bset\s+(\d{4,7})\b/i,
    /\b(\d{4,7})\b/
  ];

  for (const pattern of patterns) {
    const match = String(value || "").match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

function extractSetNumberFromBrickEconomyUrl(url: string): string | null {
  const match = url.match(/\/set\/(\d{4,7})(?:-\d+)?(?:\/|$)/i);
  return match?.[1] ?? null;
}

function extractSetNumberFromBrickLinkUrl(url: string): string | null {
  const match = url.match(/[?&]S=(\d{4,7})-\d+/i);
  return match?.[1] ?? null;
}

function extractRawBrickEconomyUrls(html: string): string[] {
  const decoded = decodeHtml(html)
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/%2F/gi, "/");

  const matches = [
    ...decoded.matchAll(
      /https?:\/\/www\.brickeconomy\.com\/set\/\d{4,7}(?:-\d+)?\/?[^"'<>\\\s]*/gi
    ),
    ...decoded.matchAll(/\/set\/\d{4,7}(?:-\d+)?\/?[^"'<>\\\s]*/gi)
  ];

  return matches.map((match) => absolutizeBrickEconomy(match[0]));
}

function extractRawBrickLinkCatalogUrls(html: string): string[] {
  const decoded = decodeHtml(html)
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/%2F/gi, "/");

  const matches = [
    ...decoded.matchAll(
      /https?:\/\/www\.bricklink\.com\/v2\/catalog\/catalogitem\.page\?S=\d{4,7}-\d+/gi
    ),
    ...decoded.matchAll(/\/v2\/catalog\/catalogitem\.page\?S=\d{4,7}-\d+/gi)
  ];

  return matches.map((match) => absolutizeBrickLink(match[0]));
}

function parsePrice(value: string | null | undefined): number | null {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const parsedEuro = parseEuroPrice(raw);
  if (parsedEuro && parsedEuro > 0) return parsedEuro;

  const cleaned = raw
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");

  const numeric = Number(cleaned);

  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() || "";

    return last
      .replace(/\.html$/i, "")
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function cleanLegoQuery(value: string): string {
  return String(value || "")
    .replace(/\blego\b/gi, "")
    .replace(/\bset\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLegoText(value: string): string {
  return normalizeText(value)
    .replace(/\blego\b/g, "")
    .replace(/\bset\b/g, "")
    .replace(/\bicons\b/g, "")
    .replace(/\bcreator\b/g, "")
    .replace(/\bexpert\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getImportantTokens(value: string): string[] {
  const stopWords = new Set([
    "lego",
    "set",
    "the",
    "and",
    "de",
    "del",
    "la",
    "el",
    "los",
    "las",
    "una",
    "uno",
    "con",
    "para"
  ]);

  return normalizeLegoText(value)
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length > 2)
    .filter((token) => !stopWords.has(token));
}

function cleanTitle(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/Catalog Item/gi, "")
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function absolutizeBrickEconomy(href: string): string {
  if (!href) return "";
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `${BRICKECONOMY_BASE_URL}${href}`;
  return `${BRICKECONOMY_BASE_URL}/${href}`;
}

function absolutizeBrickLink(href: string): string {
  if (!href) return "";
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `${BRICKLINK_BASE_URL}${href}`;
  return `${BRICKLINK_BASE_URL}/${href}`;
}