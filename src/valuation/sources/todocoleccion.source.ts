import * as cheerio from "cheerio";
import { Item } from "@prisma/client";

import {
  ScraperSourceResult,
  SupportedCurrency
} from "../scraper.types";

const BASE_URL = "https://www.todocoleccion.net";

type Candidate = {
  title: string;
  price: number;
  url: string;
};

type RankedCandidate = Candidate & {
  score: number;
  reasons: string[];
};

export async function getTodocoleccionPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  console.log("🏺 Todocoleccion called:", {
    itemId: item.id,
    name: item.name,
    category: item.category,
    platform: item.platform,
    completeness: item.completeness,
    region: item.region
  });

  const query = buildSearchQuery(item);

  const searchUrl =
    `${BASE_URL}/buscador?from=top&bu=` +
    encodeURIComponent(query);

  console.log("🏺 Todocoleccion searching:", searchUrl);

  const html = await fetchHtml(searchUrl);

  if (!html) {
    console.log("🏺 Todocoleccion no html");
    return null;
  }

  const candidates = extractCandidates(html);

  console.log("🏺 Todocoleccion candidates:", candidates);

  const filtered = candidates.filter((candidate) =>
    isRelevantCandidate(item, candidate)
  );

  console.log("🏺 Todocoleccion filtered:", filtered);

  if (filtered.length === 0) {
    console.log("🏺 Todocoleccion no match:", item.name);
    return null;
  }

  const ranked = filtered
    .map((candidate) => rankCandidate(item, candidate))
    .sort((a, b) => b.score - a.score);

  console.log(
    "🏺 Todocoleccion top:",
    ranked.slice(0, 5).map((entry) => ({
      title: entry.title,
      score: Number(entry.score.toFixed(2)),
      reasons: entry.reasons,
      price: entry.price
    }))
  );

  const best = ranked[0];

  if (!best || best.score < 0.45) {
    console.log("🏺 Todocoleccion low confidence");
    return null;
  }

  console.log("🏺 Todocoleccion best candidate:", {
    title: best.title,
    score: best.score,
    reasons: best.reasons
  });

  return {
    source: "todocoleccion",
    price: best.price,
    currency: "EUR" as SupportedCurrency,
    confidence: Number(Math.min(0.92, best.score).toFixed(2)),
    matchedTitle: best.title,
    matchedUrl: best.url,
    query,
    metadata: {
      score: best.score,
      reasons: best.reasons
    }
  };
}

function buildSearchQuery(item: Item): string {
  return item.name.trim();
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });

    if (!response.ok) {
      console.log("🏺 Todocoleccion fetch failed:", response.status);
      return null;
    }

    return await response.text();
  } catch (error) {
    console.log("🏺 Todocoleccion fetch error:", error);
    return null;
  }
}

function extractCandidates(html: string): Candidate[] {
  const $ = cheerio.load(html);

  const results: Candidate[] = [];

  $("a").each((_, element) => {
    const href = $(element).attr("href") || "";

    if (!href.includes("~x")) return;

    const title =
      $(element).attr("title") ||
      $(element).text() ||
      "";

    const cleanTitle = title.trim();

    if (!cleanTitle) return;

    const container = $(element).parent().parent();

    const text = container.text();

    const priceMatch = text.match(/(\d+[.,]?\d*)\s?€/);

    if (!priceMatch) return;

    const price = Number(
      priceMatch[1].replace(",", ".")
    );

    if (!price || Number.isNaN(price)) return;

    results.push({
      title: cleanTitle,
      price,
      url: href.startsWith("http")
        ? href
        : `${BASE_URL}${href}`
    });
  });

  return dedupeCandidates(results).slice(0, 40);
}

function dedupeCandidates(
  candidates: Candidate[]
): Candidate[] {
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    const key =
      normalizeSearchText(candidate.title) +
      "_" +
      candidate.price;

    if (seen.has(key)) return false;

    seen.add(key);

    return true;
  });
}

function isRelevantCandidate(
  item: Item,
  candidate: Candidate
): boolean {
  const normalizedTitle = normalizeSearchText(
    candidate.title
  );

  const normalizedName = normalizeSearchText(item.name);

  if (
    normalizedTitle.includes("lote") &&
    !isCompleteCollectionItem(item)
  ) {
    return false;
  }

  if (
    normalizedTitle.includes("coleccion completa") &&
    !isCompleteCollectionItem(item)
  ) {
    return false;
  }

  if (
    normalizedTitle.includes("album completo") &&
    !isCompleteCollectionItem(item)
  ) {
    return false;
  }

  if (
    normalizedTitle.includes("set completo") &&
    !isCompleteCollectionItem(item)
  ) {
    return false;
  }

  if (isStackItem(item)) {
    return passesStackCandidateValidation(
      normalizedName,
      normalizedTitle
    );
  }

  return calculateSimilarity(
    normalizedName,
    normalizedTitle
  ) >= 0.2;
}

function passesStackCandidateValidation(
  normalizedName: string,
  candidate: string
): boolean {
  if (!hasAny(candidate, ["pokemon", "pokémon"])) {
    return false;
  }

  const numberMatch = normalizedName.match(/\b(\d{1,3})\b/);

  if (numberMatch) {
    const exactNumberRegex = new RegExp(
      `\\b${numberMatch[1]}\\b`
    );

    if (!exactNumberRegex.test(candidate)) {
      return false;
    }
  }

  const umbreon =
    normalizedName.includes("umbreon") &&
    candidate.includes("umbreon");

  const mew =
    normalizedName.includes("mew") &&
    candidate.includes("mew");

  if (
    normalizedName.includes("umbreon") &&
    !umbreon
  ) {
    return false;
  }

  if (
    normalizedName.includes("mew") &&
    !mew
  ) {
    return false;
  }

  return true;
}

function rankCandidate(
  item: Item,
  candidate: Candidate
): RankedCandidate {
  const reasons: string[] = [];

  const normalizedName = normalizeSearchText(
    item.name
  );

  const normalizedTitle = normalizeSearchText(
    candidate.title
  );

  const similarity = calculateSimilarity(
    normalizedName,
    normalizedTitle
  );

  let score = similarity;

  reasons.push(
    `similarity:${similarity.toFixed(2)}`
  );

  score += 0.2;

  reasons.push("category-boost:0.20");

  if (
    normalizeCategory(item.category) === "magazine"
  ) {
    score += 0.55;

    reasons.push("magazine-boost:0.55");

    if (
      normalizedTitle === normalizedName ||
      normalizedTitle.includes(normalizedName)
    ) {
      score += 0.4;

      reasons.push("main-magazine-match");
    }
  }

  if (
    isCompleteCollectionItem(item) &&
    hasAny(normalizedTitle, [
      "coleccion completa",
      "colección completa",
      "album completo",
      "set completo",
      "260/260"
    ])
  ) {
    score += 1.35;

    reasons.push("stack-collection-boost:1.35");
  }

  if (candidate.price > 0) {
    score += 0.03;

    reasons.push("has-price");
  }

  return {
    ...candidate,
    score,
    reasons
  };
}

function calculateSimilarity(
  source: string,
  target: string
): number {
  const sourceWords = source
    .split(" ")
    .filter(Boolean);

  const targetWords = target
    .split(" ")
    .filter(Boolean);

  if (sourceWords.length === 0) return 0;

  let matches = 0;

  for (const word of sourceWords) {
    if (targetWords.includes(word)) {
      matches++;
    }
  }

  return matches / sourceWords.length;
}

function normalizeSearchText(
  value: string | null | undefined
): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCategory(
  value: string | null
): string {
  return normalizeSearchText(value);
}

function hasAny(
  text: string,
  terms: string[]
): boolean {
  return terms.some((term) =>
    text.includes(normalizeSearchText(term))
  );
}

function isStackItem(item: Item): boolean {
  const text = normalizeSearchText(
    `${item.name} ${item.platform ?? ""}`
  );

  return hasAny(text, [
    "staks",
    "stack",
    "tazo",
    "tazos"
  ]);
}

function isCompleteCollectionItem(
  item: Item
): boolean {
  const text = normalizeSearchText(
    `${item.name} ${item.platform ?? ""} ${item.completeness ?? ""} ${item.notes ?? ""}`
  );

  if (
    hasAny(text, [
      "incomplete",
      "incompleto",
      "incompleta",
      "partial",
      "parcial",
      "loose",
      "suelto",
      "suelta"
    ])
  ) {
    return false;
  }

  return (
    hasAny(text, [
      "coleccion completa",
      "colección completa",
      "set completo",
      "full set"
    ]) ||
    /\bcomplete\b/.test(text) ||
    /\bcompleto\b/.test(text) ||
    /\bcompleta\b/.test(text) ||
    /\b\d{2,4}\s*\/\s*\d{2,4}\b/.test(text)
  );
}