import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import { parseEuroPrice, normalizeText, similarityScore } from "../utils";

const BASE_URL = "https://www.chollogames.es";

type Candidate = {
  title: string;
  price: number;
  url: string;
};

export async function getCholloGamesPrice(item: Item) {
  if (item.category !== "videogame") return null;

  const query = item.name;
  const url = `${BASE_URL}/?s=${encodeURIComponent(query)}&post_type=product`;

  console.log("🎮 CG Searching:", url);

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (!res.ok) {
    console.log("❌ CG fetch failed:", res.status);
    return null;
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  const candidates: Candidate[] = [];

  $(".product").each((_, el) => {
    const title = $(el).find("h2").text().trim();
    const priceText = $(el).find(".price").first().text().trim();
    const href = $(el).find("a").attr("href");

    const price = parseEuroPrice(priceText);

    if (!title || !price || !href) return;

    candidates.push({
      title,
      price,
      url: href
    });
  });

  if (candidates.length === 0) return null;

  const best = pickBest(item, candidates);
  if (!best) return null;

  return {
    price: best.price,
    source: "chollo_games",
    confidence: computeConfidence(item, best.title)
  };
}

function pickBest(item: Item, candidates: Candidate[]) {
  const wanted = normalizeText(item.name);

  const scored = candidates.map((c) => ({
    c,
    score: similarityScore(wanted, normalizeText(c.title))
  }));

  scored.sort((a, b) => b.score - a.score);

  if (!scored[0] || scored[0].score < 0.3) return null;

  return scored[0].c;
}

function computeConfidence(item: Item, matched: string) {
  const score = similarityScore(
    normalizeText(item.name),
    normalizeText(matched)
  );

  return Math.min(0.9, 0.5 + score * 0.4);
}