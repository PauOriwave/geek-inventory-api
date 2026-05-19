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
};

const BASE_URL = "https://www.pricecharting.com";

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
        url: best.url
      }
    };
  }

  return null;
}

function buildQueries(item: Item): string[] {
  const raw = clean(item.name);

  const queries = new Set<string>();

  queries.add(`${raw} strategy guide`);
  queries.add(`${raw} official guide`);
  queries.add(`${raw} piggyback`);
  queries.add(`${raw} bradygames`);
  queries.add(raw);

  return [...queries];
}

function extractCandidates(html: string): Candidate[] {
  const $ = cheerio.load(html);

  const candidates: Candidate[] = [];

  $("table#games_table tr").each((_, el) => {
    const row = $(el);

    const link =
      row.find("td.title a").first();

    const href =
      link.attr("href") || "";

    const title =
      link.text().trim();

    const priceText =
      row.find("td.js-price").first().text().trim() ||
      row.text();

    const price =
      parsePrice(priceText);

    if (!href || !title || !price) {
      return;
    }

    candidates.push({
      title,
      price,
      url: absolutize(href)
    });
  });

  return candidates;
}

function filterCandidates(
  item: Item,
  candidates: Candidate[]
): Candidate[] {
  const wanted =
    normalizeSearchText(item.name);

  const tokens =
    wanted.split(" ")
      .filter(Boolean)
      .filter((token) => token.length > 2);

  return candidates.filter((candidate) => {
    const title =
      normalizeSearchText(candidate.title);

    const matches =
      tokens.filter((token) =>
        title.includes(token)
      );

    const ratio =
      matches.length / tokens.length;

    if (ratio < 0.6) {
      return false;
    }

    if (
      !hasAny(title, [
        "guide",
        "strategy",
        "piggyback",
        "bradygames"
      ])
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

  const wanted =
    normalizeSearchText(item.name);

  const scored = candidates.map((candidate) => {
    const title =
      normalizeSearchText(candidate.title);

    let score =
      similarityScore(wanted, title);

    if (
      hasAny(title, [
        "official guide",
        "strategy guide",
        "piggyback",
        "bradygames"
      ])
    ) {
      score += 0.25;
    }

    if (
      title.includes(wanted)
    ) {
      score += 0.2;
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

  if (!best || best.score < 0.55) {
    return null;
  }

  return best.candidate;
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
    0.5 +
    similarityScore(wanted, matched) * 0.4;

  if (
    hasAny(matched, [
      "official guide",
      "strategy guide",
      "piggyback"
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

function parsePrice(
  text: string
): number | null {
  const match =
    text.match(/\$(\d{1,6}(?:[.,]\d{1,2})?)/);

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