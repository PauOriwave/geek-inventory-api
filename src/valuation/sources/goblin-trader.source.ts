// src/valuation/sources/goblin-trader.source.ts

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

const BASE_URL = "https://www.goblintrader.es";
const REQUEST_TIMEOUT_MS = 8000;

const SUPPORTED_CATEGORIES = new Set([
  "boardgame",
  "miniature",
  "figure",
  "other"
]);

export async function getGoblinTraderPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  console.log("🧌 GoblinTrader called:", {
    itemId: item.id,
    name: item.name,
    category: item.category
  });

  if (!SUPPORTED_CATEGORIES.has(item.category)) {
    return null;
  }

  const query = cleanQuery(item.name);

  if (!query) {
    return null;
  }

  const searchUrls = buildSearchUrls(query);

  for (const searchUrl of searchUrls) {
    console.log(
      "🧌 GoblinTrader searching:",
      searchUrl
    );

    const html = await fetchHtml(searchUrl);

    if (!html) {
      continue;
    }

    const candidates = extractCandidates(html);

    console.log(
      "🧌 GoblinTrader candidates:",
      candidates
    );

    const best = pickBestCandidate(
      item,
      candidates
    );

    if (!best) {
      console.log(
        "🧌 GoblinTrader no match:",
        query
      );

      continue;
    }

    const detail = await fetchDetail(best.url);

    const finalPrice =
      detail?.price && detail.price > 0
        ? detail.price
        : best.price;

    if (!finalPrice || finalPrice <= 0) {
      continue;
    }

    const matchedTitle =
      detail?.title || best.title;

    const confidence = computeConfidence(
      item,
      matchedTitle
    );

    console.log(
      "🧌 GoblinTrader selected:",
      {
        matchedTitle,
        finalPrice,
        confidence,
        url: best.url
      }
    );

    return {
      price: Number(finalPrice.toFixed(2)),
      currency: "EUR",
      source: "goblin_trader",
      confidence,
      matchedTitle,
      matchedUrl: best.url,
      query,
      metadata: {
        provider: "goblin_trader",
        currency: "EUR",
        category: item.category,
        url: best.url
      }
    };
  }

  return null;
}

function buildSearchUrls(
  query: string
): string[] {
  const queries = buildSearchQueries(query);

  const urls: string[] = [];

  for (const searchQuery of queries) {
    const encoded =
      encodeURIComponent(searchQuery);

    urls.push(
      `${BASE_URL}/es/busqueda?controller=search&s=${encoded}`,
      `${BASE_URL}/es/buscar?controller=search&search_query=${encoded}`,
      `${BASE_URL}/busqueda?controller=search&s=${encoded}`,
      `${BASE_URL}/buscar?controller=search&search_query=${encoded}`
    );
  }

  return [...new Set(urls)];
}

function buildSearchQueries(
  query: string
): string[] {
  const clean = cleanQueryForSearch(query);

  const normalized =
    normalizeSearchText(clean);

  const queries = new Set<string>();

  queries.add(clean);

  if (
    normalized.includes("combat patrol")
  ) {
    const faction = clean
      .replace(/^combat patrol\s+/i, "")
      .trim();

    if (faction) {
      queries.add(
        `${faction} Combat Patrol`
      );

      queries.add(
        `Patrulla de Combate ${faction}`
      );
    }
  }

  if (
    normalized.includes("space marines")
  ) {
    queries.add(
      "Space Marines Combat Patrol"
    );

    queries.add(
      "Patrulla de Combate Space Marines"
    );
  }

  return [...queries]
    .map((value) =>
      value.replace(/\s+/g, " ").trim()
    )
    .filter(Boolean)
    .slice(0, 4);
}

async function fetchHtml(
  url: string
): Promise<string | null> {
  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language":
          "es-ES,es;q=0.9,en;q=0.8",
        Referer: BASE_URL
      }
    });

    if (!res.ok) {
      console.log(
        "❌ GoblinTrader fetch failed:",
        res.status,
        url
      );

      return null;
    }

    return await res.text();
  } catch (error) {
    console.log(
      "❌ GoblinTrader fetch error:",
      {
        url,
        error
      }
    );

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractCandidates(
  html: string
): Candidate[] {
  const $ = cheerio.load(html);

  const candidates: Candidate[] = [];

  const seen = new Set<string>();

  $(".product-miniature, .js-product, article").each(
    (_, el) => {
      const root = $(el);

      const href =
        root
          .find("a[href*='.html']")
          .first()
          .attr("href") || "";

      const url = absolutize(href);

      if (!looksLikeProductUrl(url)) {
        return;
      }

      const title =
        root
          .find(".product-title")
          .first()
          .text()
          .trim() ||
        root.find("h2").first().text().trim() ||
        root.find("h3").first().text().trim() ||
        titleFromProductUrl(url);

      const priceText =
        root
          .find(".price")
          .first()
          .text()
          .trim() || "";

      addCandidate({
        title,
        href: url,
        priceText,
        candidates,
        seen
      });
    }
  );

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

  if (!looksLikeProductUrl(url)) {
    return;
  }

  const title = cleanTitle(input.title);

  const price = parsePrice(
    input.priceText
  );

  if (!title || !url) {
    return;
  }

  const key = `${normalizeText(
    title
  )}|${url}`;

  if (input.seen.has(key)) {
    return;
  }

  input.seen.add(key);

  input.candidates.push({
    title,
    price,
    url
  });
}

async function fetchDetail(
  url: string
): Promise<{
  title: string | null;
  price: number | null;
} | null> {
  const html = await fetchHtml(url);

  if (!html) {
    return null;
  }

  const $ = cheerio.load(html);

  const title =
    $("h1").first().text().trim() ||
    titleFromProductUrl(url);

  const price =
    parsePrice(
      $(".price").first().text().trim()
    ) ??
    extractPriceFromJson(html);

  return {
    title,
    price
  };
}

function pickBestCandidate(
  item: Item,
  candidates: Candidate[]
): Candidate | null {
  const wanted =
    normalizeSearchText(item.name);

  const importantTokens =
    getImportantTokens(wanted);

  const filtered = candidates.filter(
    (candidate) => {
      const title =
        normalizeSearchText(
          candidate.title
        );

      return importantTokens.every(
        (token) =>
          title.includes(token)
      );
    }
  );

  console.log(
    "🧌 GoblinTrader filtered:",
    filtered
  );

  if (filtered.length === 0) {
    return null;
  }

  const scored = filtered.map(
    (candidate) => {
      const title =
        normalizeSearchText(
          candidate.title
        );

      let score = similarityScore(
        wanted,
        title
      );

      if (title.includes(wanted)) {
        score += 0.3;
      }

      return {
        candidate,
        score
      };
    }
  );

  scored.sort(
    (a, b) => b.score - a.score
  );

  const best = scored[0];

  if (!best || best.score < 0.45) {
    return null;
  }

  return best.candidate;
}

function parsePrice(
  text: string | null | undefined
): number | null {
  const value = String(text || "").trim();

  if (!value) {
    return null;
  }

  const numeric = Number(
    value.replace(",", ".")
  );

  if (
    Number.isFinite(numeric) &&
    numeric > 0
  ) {
    return numeric;
  }

  return parseEuroPrice(value);
}

function extractPriceFromJson(
  html: string
): number | null {
  const matches = [
    ...html.matchAll(
      /"price"\s*:\s*"?(\d+(?:[.,]\d+)?)"?/g
    )
  ];

  const prices = matches
    .map((match) =>
      Number(
        String(match[1]).replace(
          ",",
          "."
        )
      )
    )
    .filter(
      (price) =>
        Number.isFinite(price) &&
        price > 0
    );

  return prices[0] ?? null;
}

function titleFromProductUrl(
  url: string
): string {
  try {
    const parsed = new URL(url);

    const last =
      parsed.pathname
        .split("/")
        .filter(Boolean)
        .pop() || "";

    return last
      .replace(/\.html$/i, "")
      .replace(/^\d+-/, "")
      .replace(/-\d+$/, "")
      .replace(/-/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function getImportantTokens(
  normalizedText: string
): string[] {
  const stopWords = new Set([
    "the",
    "and",
    "combat",
    "patrol",
    "warhammer",
    "40000",
    "40k"
  ]);

  return normalizedText
    .split(" ")
    .filter(Boolean)
    .filter(
      (token) => token.length > 2
    )
    .filter(
      (token) => !stopWords.has(token)
    );
}

function normalizeSearchText(
  value: string
): string {
  return normalizeText(value)
    .replace(/\s+/g, " ")
    .trim();
}

function cleanQuery(
  value: string
): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanQueryForSearch(
  value: string
): string {
  return String(value || "")
    .replace(/warhammer\s*40k/gi, "")
    .replace(/warhammer\s*40000/gi, "")
    .replace(/wh40k/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTitle(
  value: string
): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeProductUrl(
  url: string
): boolean {
  const normalized =
    url.toLowerCase();

  if (!normalized.startsWith("http")) {
    return false;
  }

  if (
    !normalized.includes(
      "goblintrader.es"
    )
  ) {
    return false;
  }

  if (!normalized.endsWith(".html")) {
    return false;
  }

  return true;
}

function absolutize(
  href: string
): string {
  if (!href) {
    return "";
  }

  if (href.startsWith("http")) {
    return href;
  }

  if (href.startsWith("/")) {
    return `${BASE_URL}${href}`;
  }

  return `${BASE_URL}/${href}`;
}

function computeConfidence(
  item: Item,
  matchedTitle: string
): number {
  const wanted =
    normalizeSearchText(item.name);

  const matched =
    normalizeSearchText(matchedTitle);

  let confidence =
    0.45 +
    similarityScore(
      wanted,
      matched
    ) *
      0.45;

  if (matched.includes(wanted)) {
    confidence += 0.05;
  }

  return Math.max(
    0.2,
    Math.min(
      0.92,
      Number(
        confidence.toFixed(2)
      )
    )
  );
}