import { Item } from "@prisma/client";
import * as cheerio from "cheerio";

import { ScraperSourceResult } from "../scraper.types";
import { normalizeText, parseEuroPrice, similarityScore } from "../utils";

type GoblinTraderCandidate = {
  title: string;
  url: string;
  price: number | null;
  score: number;
  source: "search" | "raw_url" | "direct_url";
};

const BASE_URL = "https://www.goblintrader.es";
const REQUEST_TIMEOUT_MS = 15000;

const SUPPORTED_CATEGORIES = new Set([
  "boardgame",
  "miniature",
  "figure",
  "other"
]);

const WARHAMMER_HINTS = [
  "warhammer",
  "40k",
  "40000",
  "age of sigmar",
  "aos",
  "citadel",
  "games workshop",
  "space marines",
  "combat patrol",
  "kill team",
  "necromunda",
  "blood bowl",
  "horus heresy",
  "codex",
  "battletome"
];

const MINIATURE_BLOCKED_TITLE_TOKENS = [
  "codex",
  "index cards",
  "datacards",
  "data cards",
  "dados",
  "dice",
  "cartas",
  "cards",
  "battletome",
  "libro",
  "book"
];

const MINIATURE_REQUIRED_EQUIVALENCES = [
  {
    wanted: ["combat patrol"],
    accepted: ["combat patrol", "patrulla de combate"]
  },
  {
    wanted: ["battleforce"],
    accepted: ["battleforce"]
  },
  {
    wanted: ["kill team"],
    accepted: ["kill team"]
  }
];

export async function getGoblinTraderPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (!SUPPORTED_CATEGORIES.has(item.category)) return null;

  const query = String(item.name || "").trim();
  if (!query) return null;

  console.log("🧌 GoblinTrader called:", {
    itemId: item.id,
    name: item.name,
    category: item.category,
    platform: item.platform,
    region: item.region,
    notes: item.notes
  });

  const candidates = await resolveCandidates(item, query);

  console.log(
    "🧌 GoblinTrader candidates:",
    candidates.slice(0, 12).map((candidate) => ({
      title: candidate.title,
      price: candidate.price,
      score: Number(candidate.score.toFixed(2)),
      source: candidate.source,
      url: candidate.url
    }))
  );

  const best = candidates[0];

  if (!best || best.score < 0.55) {
    console.log("🧌 GoblinTrader no match:", query);
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

  if (isInvalidMiniatureMatch(item, finalTitle, best.url)) {
    console.log("🧌 GoblinTrader discarded invalid miniature detail match:", {
      query,
      title: finalTitle,
      url: best.url
    });

    return null;
  }

  if (!finalPrice || finalPrice <= 0) {
    console.log("🧌 GoblinTrader matched but no price:", {
      query,
      title: finalTitle,
      url: best.url
    });

    return null;
  }

  const confidence = computeConfidence(item, query, finalTitle, best.score);

  return {
    price: Number(finalPrice.toFixed(2)),
    currency: "EUR",
    source: "goblin_trader",
    confidence,
    matchedTitle: finalTitle,
    matchedUrl: best.url,
    query,
    metadata: {
      provider: "goblin_trader",
      currency: "EUR",
      listingPrice: best.price,
      finalPrice,
      category: item.category,
      platform: item.platform ?? null,
      region: item.region ?? null,
      candidate: best,
      candidates: candidates.slice(0, 12),
      warhammerDetected: hasWarhammerSignal(
        `${item.name} ${item.platform ?? ""} ${item.region ?? ""} ${
          item.notes ?? ""
        } ${finalTitle}`
      )
    }
  };
}

async function resolveCandidates(
  item: Item,
  query: string
): Promise<GoblinTraderCandidate[]> {
  const allCandidates: GoblinTraderCandidate[] = [];
  const seen = new Set<string>();

  const manualUrls = extractGoblinTraderUrlsFromItem(item);

  for (const url of manualUrls) {
    addCandidate(allCandidates, seen, {
      title: titleFromUrl(url),
      url,
      price: null,
      score: 3,
      source: "direct_url"
    });
  }

  const searchCandidates = await searchGoblinTrader(item, query);

  for (const candidate of searchCandidates) {
    addCandidate(allCandidates, seen, candidate);
  }

  return allCandidates.sort((a, b) => b.score - a.score).slice(0, 30);
}

function extractGoblinTraderUrlsFromItem(item: Item): string[] {
  const values = [item.notes, item.region, item.platform]
    .map((value) => String(value || ""))
    .filter(Boolean);

  const urls: string[] = [];

  for (const value of values) {
    const matches = value.match(
      /https?:\/\/(?:www\.)?goblintrader\.es\/[^\s"'<>]+/gi
    );

    for (const match of matches ?? []) {
      const clean = decodeHtml(match.trim());

      if (isProductUrl(clean)) {
        urls.push(clean);
      }
    }
  }

  return [...new Set(urls)];
}

async function searchGoblinTrader(
  item: Item,
  query: string
): Promise<GoblinTraderCandidate[]> {
  const urls = buildSearchUrls(query);
  const allCandidates: GoblinTraderCandidate[] = [];
  const seen = new Set<string>();

  for (const url of urls) {
    console.log("🧌 GoblinTrader searching:", url);

    const html = await fetchHtml(url);
    if (!html) continue;

    const candidates = extractCandidates(html, item, query);

    for (const candidate of candidates) {
      addCandidate(allCandidates, seen, candidate);
    }

    if (allCandidates.length > 0) break;
  }

  return allCandidates.sort((a, b) => b.score - a.score).slice(0, 20);
}

function buildSearchUrls(query: string): string[] {
  const queries = buildSearchQueries(query);
  const urls: string[] = [];

  for (const searchQuery of queries) {
    const encoded = encodeURIComponent(searchQuery);

    urls.push(
      `${BASE_URL}/es/busqueda?controller=search&s=${encoded}`,
      `${BASE_URL}/es/buscar?controller=search&search_query=${encoded}`,
      `${BASE_URL}/busqueda?controller=search&s=${encoded}`,
      `${BASE_URL}/buscar?controller=search&search_query=${encoded}`,
      `${BASE_URL}/es/search?controller=search&s=${encoded}`,
      `${BASE_URL}/search?controller=search&s=${encoded}`
    );
  }

  return [...new Set(urls)];
}

function buildSearchQueries(query: string): string[] {
  const clean = cleanQueryForSearch(query);
  const normalized = normalizeSearchText(clean);
  const queries = new Set<string>();

  queries.add(clean);

  if (normalized.includes("combat patrol")) {
    const faction = clean.replace(/^combat patrol\s+/i, "").trim();

    queries.add(`Warhammer 40000 ${clean}`);
    queries.add(`Warhammer 40K ${clean}`);

    if (faction) {
      queries.add(`${faction} Combat Patrol`);
      queries.add(`Warhammer 40000 ${faction} Combat Patrol`);
      queries.add(`Warhammer 40K ${faction} Combat Patrol`);
      queries.add(`Patrulla de Combate ${faction}`);
    }
  }

  if (normalized.includes("space marines")) {
    queries.add("Space Marines Combat Patrol");
    queries.add("Warhammer 40000 Space Marines Combat Patrol");
    queries.add("Warhammer 40K Space Marines Combat Patrol");
    queries.add("Patrulla de Combate Space Marines");
  }

  return [...queries]
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function extractCandidates(
  html: string,
  item: Item,
  query: string
): GoblinTraderCandidate[] {
  const $ = cheerio.load(html);
  const candidates: GoblinTraderCandidate[] = [];
  const seen = new Set<string>();

  const cardSelectors = [
    ".js-product",
    ".product-miniature",
    ".product",
    ".product-item",
    ".thumbnail-container",
    "article.product-miniature",
    "article",
    "li"
  ];

  for (const selector of cardSelectors) {
    $(selector).each((_, el) => {
      const root = $(el);

      const href =
        root.find("a[href*='.html']").first().attr("href") ||
        root.find("a[href]").first().attr("href") ||
        "";

      const url = absolutize(href);
      if (!isProductUrl(url)) return;

      const title =
        cleanTitle(root.find(".product-title a").first().text()) ||
        cleanTitle(root.find(".product-title").first().text()) ||
        cleanTitle(root.find(".h3.product-title").first().text()) ||
        cleanTitle(root.find("h2").first().text()) ||
        cleanTitle(root.find("h3").first().text()) ||
        cleanTitle(root.find("a[title]").first().attr("title") || "") ||
        cleanTitle(root.find("img[alt]").first().attr("alt") || "") ||
        titleFromUrl(url);

      if (isInvalidMiniatureMatch(item, title, url)) return;

      const priceText =
        root.find(".product-price-and-shipping .price").first().text().trim() ||
        root.find(".price").first().text().trim() ||
        root.find(".current-price").first().text().trim() ||
        root.find("[itemprop='price']").first().attr("content") ||
        root.find("[itemprop='price']").first().text().trim() ||
        root.text();

      const price = parsePrice(priceText);
      const score = scoreCandidate(item, query, title, url);

      if (score < 0.35) return;

      addCandidate(candidates, seen, {
        title,
        url,
        price,
        score,
        source: "search"
      });
    });
  }

  $("a[href]").each((_, el) => {
    const link = $(el);
    const href = decodeHtml(link.attr("href") || "");
    const url = absolutize(href);

    if (!isProductUrl(url)) return;

    const root = link.closest("li, article, div, section");

    const title =
      cleanTitle(link.attr("title") || "") ||
      cleanTitle(link.find("img").first().attr("alt") || "") ||
      cleanTitle(link.text()) ||
      cleanTitle(
        root.find("h1, h2, h3, .product-title, .title").first().text()
      ) ||
      titleFromUrl(url);

    if (isInvalidMiniatureMatch(item, title, url)) return;

    const priceText =
      root.find(".product-price-and-shipping .price").first().text().trim() ||
      root.find(".price").first().text().trim() ||
      root.find(".current-price").first().text().trim() ||
      root.find("[itemprop='price']").first().attr("content") ||
      root.find("[itemprop='price']").first().text().trim() ||
      root.text();

    const price = parsePrice(priceText);
    const score = scoreCandidate(item, query, title, url);

    if (score < 0.35) return;

    addCandidate(candidates, seen, {
      title,
      url,
      price,
      score,
      source: "search"
    });
  });

  extractRawProductUrls(html).forEach((url) => {
    const title = titleFromUrl(url);

    if (isInvalidMiniatureMatch(item, title, url)) return;

    const score = scoreCandidate(item, query, title, url);

    if (score < 0.35) return;

    addCandidate(candidates, seen, {
      title,
      url,
      price: null,
      score,
      source: "raw_url"
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
    cleanTitle($("h1[itemprop='name']").first().text()) ||
    cleanTitle($("h1").first().text()) ||
    cleanTitle($("meta[property='og:title']").attr("content") || "") ||
    cleanTitle($("[itemprop='name']").first().text()) ||
    titleFromUrl(url);

  const price =
    parsePrice($("meta[property='product:price:amount']").attr("content")) ??
    parsePrice($("meta[itemprop='price']").attr("content")) ??
    parsePrice($("[itemprop='price']").first().attr("content")) ??
    parsePrice($("[itemprop='price']").first().text().trim()) ??
    parsePrice($(".current-price .price").first().text().trim()) ??
    parsePrice($(".product-prices .price").first().text().trim()) ??
    parsePrice($(".price").first().text().trim()) ??
    extractPriceFromJson(html) ??
    extractFirstEuroPrice($("body").text()) ??
    null;

  console.log("🧌 GoblinTrader detail parsed:", {
    url,
    title,
    price
  });

  if (!title && !price) return null;

  return {
    title,
    price
  };
}

function scoreCandidate(
  item: Item,
  query: string,
  title: string,
  url: string
): number {
  let score = 0;

  const wanted = normalizeSearchText(query);
  const normalizedTitle = normalizeSearchText(title);
  const normalizedUrl = normalizeSearchText(url).replace(/\s+/g, "-");

  const itemContext = normalizeSearchText(
    `${item.name} ${item.platform ?? ""} ${item.region ?? ""} ${
      item.notes ?? ""
    }`
  );

  const candidateContext = normalizeSearchText(`${title} ${url}`);

  if (isInvalidMiniatureMatch(item, title, url)) {
    return 0;
  }

  score += similarityScore(wanted, normalizedTitle);

  if (normalizedTitle === wanted) score += 1;
  if (normalizedTitle.includes(wanted)) score += 0.7;
  if (normalizedUrl.includes(wanted.replace(/\s+/g, "-"))) score += 0.65;

  const wantedTokens = getImportantTokens(wanted);
  const matchedTokens = wantedTokens.filter(
    (token) => normalizedTitle.includes(token) || normalizedUrl.includes(token)
  );

  if (wantedTokens.length > 0) {
    score += (matchedTokens.length / wantedTokens.length) * 0.8;
  }

  if (hasWarhammerSignal(itemContext) && hasWarhammerSignal(candidateContext)) {
    score += 0.4;
  }

  if (item.category === "figure" || item.category === "miniature") {
    if (
      candidateContext.includes("miniatura") ||
      candidateContext.includes("miniature") ||
      candidateContext.includes("figura") ||
      candidateContext.includes("figure")
    ) {
      score += 0.15;
    }
  }

  if (item.category === "boardgame") {
    if (
      candidateContext.includes("juego") ||
      candidateContext.includes("boardgame") ||
      candidateContext.includes("mesa") ||
      candidateContext.includes("expansion")
    ) {
      score += 0.15;
    }
  }

  if (item.category === "other" && hasWarhammerSignal(itemContext)) {
    if (!hasWarhammerSignal(candidateContext)) {
      score -= 0.35;
    }
  }

  return Number(score.toFixed(4));
}

function computeConfidence(
  item: Item,
  query: string,
  title: string,
  score: number
): number {
  let confidence = 0.45;

  const normalizedQuery = normalizeSearchText(query);
  const normalizedTitle = normalizeSearchText(title);

  confidence += Math.min(0.25, score * 0.12);

  if (normalizedTitle === normalizedQuery) confidence += 0.25;
  if (normalizedTitle.includes(normalizedQuery)) confidence += 0.15;

  const queryTokens = getImportantTokens(normalizedQuery);
  const matchedTokens = queryTokens.filter((token) =>
    normalizedTitle.includes(token)
  );

  if (queryTokens.length > 0) {
    confidence += (matchedTokens.length / queryTokens.length) * 0.15;
  }

  const itemContext = `${item.name} ${item.platform ?? ""} ${
    item.region ?? ""
  } ${item.notes ?? ""}`;

  if (hasWarhammerSignal(itemContext) && hasWarhammerSignal(title)) {
    confidence += 0.08;
  }

  return Math.max(0.45, Math.min(0.92, Number(confidence.toFixed(2))));
}

function isInvalidMiniatureMatch(item: Item, title: string, url: string): boolean {
  if (item.category !== "miniature") return false;

  const wanted = normalizeSearchText(item.name);
  const candidate = normalizeSearchText(`${title} ${url}`);

  for (const rule of MINIATURE_REQUIRED_EQUIVALENCES) {
    const wantedHasRule = rule.wanted.some((token) =>
      wanted.includes(normalizeSearchText(token))
    );

    if (!wantedHasRule) continue;

    const candidateHasAccepted = rule.accepted.some((token) =>
      candidate.includes(normalizeSearchText(token))
    );

    if (!candidateHasAccepted) return true;
  }

  return MINIATURE_BLOCKED_TITLE_TOKENS.some((token) =>
    candidate.includes(normalizeSearchText(token))
  );
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

function extractFirstEuroPrice(text: string): number | null {
  const patterns = [
    /(\d{1,5}(?:[.,]\d{1,2})?)\s*€/,
    /€\s*(\d{1,5}(?:[.,]\d{1,2})?)/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (!match?.[1]) continue;

    const price = parsePrice(match[1]);
    if (price && price > 0) return price;
  }

  return null;
}

function extractPriceFromJson(html: string): number | null {
  const matches = [
    ...html.matchAll(/"price"\s*:\s*"?(\d+(?:[.,]\d+)?)"?/g),
    ...html.matchAll(/"salePrice"\s*:\s*"?(\d+(?:[.,]\d+)?)"?/g),
    ...html.matchAll(/"finalPrice"\s*:\s*"?(\d+(?:[.,]\d+)?)"?/g)
  ];

  const prices = matches
    .map((match) => Number(String(match[1]).replace(",", ".")))
    .filter((price) => Number.isFinite(price) && price > 0 && price < 10000)
    .sort((a, b) => b - a);

  return prices[0] ?? null;
}

function extractRawProductUrls(html: string): string[] {
  const normalizedHtml = decodeHtml(html)
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/%2F/gi, "/");

  const patterns = [
    /https?:\/\/(?:www\.)?goblintrader\.es\/[^"'<>\\\s]+\.html/gi,
    /\/[^"'<>\\\s]+\.html/gi
  ];

  const urls: string[] = [];

  for (const pattern of patterns) {
    for (const match of normalizedHtml.matchAll(pattern)) {
      const rawUrl = match[0];
      const url = absolutize(rawUrl);

      if (isProductUrl(url)) {
        urls.push(url);
      }
    }
  }

  return [...new Set(urls)];
}

function addCandidate(
  candidates: GoblinTraderCandidate[],
  seen: Set<string>,
  candidate: GoblinTraderCandidate
) {
  if (!candidate.url) return;

  const url = normalizeCandidateUrl(candidate.url);

  if (!isProductUrl(url)) return;
  if (seen.has(url)) return;

  const title = cleanTitle(candidate.title || titleFromUrl(url));

  if (!title) return;

  seen.add(url);

  candidates.push({
    ...candidate,
    title,
    url
  });
}

function normalizeCandidateUrl(url: string): string {
  try {
    const parsed = new URL(url);

    parsed.hash = "";

    return parsed.toString();
  } catch {
    return url;
  }
}

function isProductUrl(url: string): boolean {
  const normalized = url.toLowerCase();

  if (!normalized.startsWith("http")) return false;
  if (!normalized.includes("goblintrader.es")) return false;

  if (normalized.includes("/busqueda")) return false;
  if (normalized.includes("/buscar")) return false;
  if (normalized.includes("/search")) return false;
  if (normalized.includes("/carrito")) return false;
  if (normalized.includes("/cart")) return false;
  if (normalized.includes("/login")) return false;
  if (normalized.includes("/mi-cuenta")) return false;
  if (normalized.includes("/my-account")) return false;
  if (normalized.includes("#")) return false;

  return normalized.endsWith(".html");
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() || "";

    return last
      .replace(/^\d+-/i, "")
      .replace(/-\d+\.html$/i, "")
      .replace(/\.html$/i, "")
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
    "the",
    "juego",
    "boardgame",
    "mesa",
    "figura",
    "figure",
    "miniatura",
    "miniature"
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

function cleanQueryForSearch(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasWarhammerSignal(value: string): boolean {
  const normalized = normalizeSearchText(value);

  return WARHAMMER_HINTS.some((token) =>
    normalized.includes(normalizeSearchText(token))
  );
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

  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }

  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `${BASE_URL}${href}`;

  return `${BASE_URL}/${href}`;
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
      console.log("❌ GoblinTrader fetch failed:", {
        status: res.status,
        url
      });

      return null;
    }

    return await res.text();
  } catch (error) {
    console.log("❌ GoblinTrader fetch error:", {
      url,
      error
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}