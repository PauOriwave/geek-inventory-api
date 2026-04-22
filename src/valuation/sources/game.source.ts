import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import { parseEuroPrice } from "../utils";
import {
  buildSearchText,
  pickBestBySimilarity,
  computeConfidenceFromScore
} from "../scraper.utils";

type GameCandidate = {
  title: string;
  price: number;
};

const GAME_BASE_URL = "https://www.game.es";

export async function getGamePrice(item: Item) {
  const query = buildSearchText(item);
  if (!query) return null;

  const url = `${GAME_BASE_URL}/search?q=${encodeURIComponent(query)}`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "text/html"
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

    const best = pickBestBySimilarity(item, candidates);
    if (!best) return null;

    const confidence = computeConfidenceFromScore(0.6);

    return {
      price: best.price,
      source: "game",
      confidence
    };
  } catch (err) {
    console.error("GAME error:", err);
    return null;
  }
}

function extractCandidates(html: string): GameCandidate[] {
  const $ = cheerio.load(html);
  const results: GameCandidate[] = [];

  $("a").each((_, el) => {
    const root = $(el);

    const title = root.text().trim();
    if (!title || title.length < 5) return;

    const priceText = root
      .parent()
      .find("[class*='price']")
      .first()
      .text();

    const price = parseEuroPrice(priceText);
    if (!price) return;

    results.push({ title, price });
  });

  return results;
}