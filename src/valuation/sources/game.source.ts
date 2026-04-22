import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import { parseEuroPrice } from "../utils";
import {
  buildSearchText,
  pickBestBySimilarity,
  computeConfidenceFromScore
} from "../scraper.utils";
import { ScraperSourceResult } from "../scraper.types";

type GameCandidate = {
  title: string;
  price: number;
  href?: string;
};

const GAME_BASE_URL = "https://www.game.es";

export async function getGamePrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  const query = buildSearchText(item);
  if (!query) return null;

  const searchUrl = `${GAME_BASE_URL}/search?q=${encodeURIComponent(query)}`;

  try {
    const res = await fetch(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"
      }
    });

    if (!res.ok) {
      console.error("GAME fetch failed:", res.status);
      return null;
    }

    const html = await res.text();
    const candidates = extractCandidates(html);

    if (candidates.length === 0) {
      console.log("GAME no candidates:", query);
      return null;
    }

    const best = pickBestBySimilarity(item, candidates, 0.25);

    if (!best) {
      console.log("GAME no match:", query);
      return null;
    }

    const confidence = computeConfidenceFromScore(0.6);

    return {
      price: best.price,
      source: "game",
      confidence,
      matchedTitle: best.title,
      matchedUrl: best.href,
      query
    };
  } catch (err) {
    console.error("GAME error:", err);
    return null;
  }
}

function extractCandidates(html: string): GameCandidate[] {
  const $ = cheerio.load(html);
  const results: GameCandidate[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_, el) => {
    const root = $(el);

    const title =
      root.attr("title")?.trim() ||
      root.text().trim();

    if (!title || title.length < 5) return;

    const href = root.attr("href") || undefined;

    const priceText =
      root.find("[class*='price']").first().text().trim() ||
      root.parent().find("[class*='price']").first().text().trim() ||
      root.closest("article, li, div").find("[class*='price']").first().text().trim();

    const price = parseEuroPrice(priceText);
    if (price == null || price <= 0) return;

    const key = `${title.toLowerCase()}|${price}`;
    if (seen.has(key)) return;
    seen.add(key);

    results.push({
      title,
      price,
      href: href ? absolutize(href) : undefined
    });
  });

  return results;
}

function absolutize(href: string): string {
  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }

  if (href.startsWith("/")) {
    return `${GAME_BASE_URL}${href}`;
  }

  return `${GAME_BASE_URL}/${href}`;
}