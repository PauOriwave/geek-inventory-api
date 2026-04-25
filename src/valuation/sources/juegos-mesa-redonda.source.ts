import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import {
  normalizeText,
  parseEuroPrice,
  similarityScore
} from "../utils";

type JuegosMesaRedondaCandidate = {
  title: string;
  price: number;
  url: string;
};

const BASE_URL = "https://juegosdelamesaredonda.com";

export async function getJuegosMesaRedondaPrice(item: Item) {
  if (item.category !== "boardgame") {
    return null;
  }

  const query = buildSearchQuery(item);
  if (!query) return null;

  const searchUrl = `${BASE_URL}/buscar?controller=search&s=${encodeURIComponent(
    query
  )}`;

  console.log("🔍 JMR Searching:", searchUrl);

  const res = await fetch(searchUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127.0 Safari/537.36"
    }
  });

  if (!res.ok) {
    console.log("❌ JMR search failed:", res.status);
    return null;
  }

  const html = await res.text();
  const candidates = extractCandidates(html);

  console.log("📦 JMR candidates:", candidates.length);

  if (candidates.length === 0) return null;

  const best = pickBestCandidate(item, candidates);

  if (!best) {
    console.log("❌ JMR no match:", item.name);
    return null;
  }

  const detailPrice = await fetchDetailPrice(best.url);

  console.log("📄 JMR detail price:", {
    title: best.title,
    listingPrice: best.price,
    detailPrice,
    url: best.url
  });

  const finalPrice = chooseFinalPrice({
    listingPrice: best.price,
    detailPrice
  });

  return {
    price: Number(finalPrice.toFixed(2)),
    source: "juegos_mesa_redonda",
    confidence: computeConfidence(item, best.title),
    matchedTitle: best.title,
    matchedUrl: best.url,
    query
  };
}

function buildSearchQuery(item: Item): string {
  return [item.name, item.platform ?? "", item.region ?? ""]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function extractCandidates(html: string): JuegosMesaRedondaCandidate[] {
  const $ = cheerio.load(html);
  const results: JuegosMesaRedondaCandidate[] = [];

  $(".product-miniature").each((_, el) => {
    const root = $(el);

    const title = root.find(".product-title a").text().trim();
    const priceText =
      root.find(".current-price .price").first().text().trim() ||
      root.find(".price").first().text().trim();

    const href = root.find(".product-title a").attr("href") || root.find("a").attr("href");

    const price = parseEuroPrice(priceText);

    if (!title || !price || !href) return;

    results.push({
      title,
      price,
      url: absolutize(href)
    });
  });

  return results;
}

function pickBestCandidate(
  item: Item,
  candidates: JuegosMesaRedondaCandidate[]
): JuegosMesaRedondaCandidate | null {
  const wanted = normalizeSearchTitle(item.name);

  const exactOrContained = candidates.find((candidate) => {
    const title = normalizeSearchTitle(candidate.title);

    return title === wanted || title.includes(wanted) || wanted.includes(title);
  });

  if (exactOrContained) {
    return exactOrContained;
  }

  const closeCandidates = candidates.filter((candidate) => {
    const title = normalizeSearchTitle(candidate.title);
    const wantedTokens = wanted.split(" ").filter(Boolean);

    return wantedTokens.every((token) => title.includes(token));
  });

  if (closeCandidates.length > 0) {
    return pickBestBySimilarity(item, closeCandidates, 0.15);
  }

  return null;
}

function normalizeSearchTitle(value: string | null): string {
  return normalizeText(value || "")
    .replace(/\bcastellano\b/g, "")
    .replace(/\bespanol\b/g, "")
    .replace(/\bespañol\b/g, "")
    .replace(/\bsegunda\b/g, "")
    .replace(/\bmano\b/g, "")
    .replace(/\bjuego\b/g, "")
    .replace(/\bmesa\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pickBestBySimilarity(
  item: Item,
  candidates: JuegosMesaRedondaCandidate[],
  threshold: number
): JuegosMesaRedondaCandidate | null {
  const wanted = normalizeSearchTitle(item.name);

  const scored = candidates.map((candidate) => ({
    candidate,
    score: similarityScore(wanted, normalizeSearchTitle(candidate.title))
  }));

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (!best || best.score < threshold) return null;

  return best.candidate;
}

async function fetchDetailPrice(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127.0 Safari/537.36"
      }
    });

    if (!res.ok) {
      console.log("❌ JMR detail fetch failed:", res.status);
      return null;
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    const priceText =
      $(".current-price .price").first().text().trim() ||
      $(".product-prices .current-price").first().text().trim() ||
      $(".product-price").first().text().trim() ||
      $("[itemprop='price']").first().text().trim();

    const price = parseEuroPrice(priceText);

    return price ?? null;
  } catch (err) {
    console.log("❌ JMR detail error:", err);
    return null;
  }
}

function chooseFinalPrice(input: {
  listingPrice: number;
  detailPrice: number | null;
}): number {
  const { listingPrice, detailPrice } = input;

  if (!detailPrice || detailPrice <= 0) {
    return listingPrice;
  }

  const maxAllowedDifference = listingPrice * 0.2;
  const difference = Math.abs(detailPrice - listingPrice);

  if (difference <= maxAllowedDifference) {
    return detailPrice;
  }

  console.log("⚠️ JMR detail price rejected, using listing price:", {
    listingPrice,
    detailPrice,
    difference
  });

  return listingPrice;
}

function absolutize(href: string): string {
  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }

  if (href.startsWith("/")) {
    return `${BASE_URL}${href}`;
  }

  return `${BASE_URL}/${href}`;
}

function computeConfidence(item: Item, matchedTitle: string): number {
  const wanted = normalizeSearchTitle(item.name);
  const matched = normalizeSearchTitle(matchedTitle);

  const base = similarityScore(wanted, matched);

  let confidence = 0.5 + base * 0.4;

  if (matched.includes(wanted)) {
    confidence += 0.05;
  }

  return Math.max(0.2, Math.min(0.95, Number(confidence.toFixed(2))));
}