import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import { normalizeText, similarityScore, parseEuroPrice } from "../utils";
import { ScraperSourceResult } from "../scraper.types";

type Candidate = {
  title: string;
  price: number;
  url: string;
};

const BASE_URL = "https://www.game.es";

export async function getGamePrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (item.category !== "videogame") return null;

  const query = item.name.trim();
  if (!query) return null;

  const searchUrl = `${BASE_URL}/Search/?q=${encodeURIComponent(query)}`;

  console.log("🎮 GAME Searching:", searchUrl);

  const html = await fetchHtml(searchUrl);
  if (!html) return null;

  const candidates = extractCandidates(html);

  console.log("🎮 GAME candidates:", candidates.length);

  if (candidates.length === 0) return null;

  const best = pickBestCandidate(item, candidates);

  if (!best) {
    console.log("🎮 GAME no match:", query);
    return null;
  }

  console.log("🎮 GAME selected:", best);

  return {
    price: Number(best.price.toFixed(2)),
    source: "game",
    confidence: computeConfidence(item.name, best.title),
    matchedTitle: best.title,
    matchedUrl: best.url,
    query
  };
}

/* ============================= */

async function fetchHtml(url: string): Promise<string | null> {
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

/* ============================= */

function extractCandidates(html: string): Candidate[] {
  const $ = cheerio.load(html);
  const candidates: Candidate[] = [];

  $(".search-item, .product-item, .item").each((_, el) => {
    const root = $(el);

    const title =
      root.find(".title").text().trim() ||
      root.find("h3").text().trim();

    const priceText =
      root.find(".price").text().trim() ||
      root.text();

    const href =
      root.find("a").attr("href") || "";

    const price = parseEuroPrice(priceText);

    if (!title || !price || !href) return;

    const url = absolutize(href);

    candidates.push({
      title: cleanTitle(title),
      price,
      url
    });
  });

  return candidates;
}

/* ============================= */

function pickBestCandidate(
  item: Item,
  candidates: Candidate[]
): Candidate | null {
  const wanted = normalizeText(item.name);

  const scored = candidates.map((c) => {
    const title = normalizeText(c.title);

    let score = similarityScore(wanted, title);

    if (title.includes(wanted)) score += 0.3;

    return {
      candidate: c,
      score
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (!best || best.score < 0.4) return null;

  return best.candidate;
}

/* ============================= */

function computeConfidence(
  wanted: string,
  matched: string
): number {
  const a = normalizeText(wanted);
  const b = normalizeText(matched);

  let confidence = 0.5 + similarityScore(a, b) * 0.4;

  if (b.includes(a)) confidence += 0.05;

  return Math.min(0.92, Number(confidence.toFixed(2)));
}

/* ============================= */

function cleanTitle(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/comprar/gi, "")
    .trim();
}

function absolutize(href: string): string {
  if (href.startsWith("http")) return href;
  return `${BASE_URL}${href}`;
}