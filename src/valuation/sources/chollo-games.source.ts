import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import { normalizeText, parseEuroPrice, similarityScore } from "../utils";
import { ScraperSourceResult } from "../scraper.types";

type Candidate = {
  title: string;
  price: number;
  url: string;
};

const BASE_URL = "https://www.chollogames.es";
const REQUEST_TIMEOUT_MS = 15000;

export async function getCholloGamesPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (item.category !== "videogame") return null;

  const query = item.name.trim();
  if (!query) return null;

  const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}&post_type=product`;

  console.log("🎮 CG Searching:", searchUrl);

  const html = await fetchHtml(searchUrl);
  if (!html) return null;

  const candidates = extractCandidates(html);

  console.log("🎮 CG candidates:", candidates.length, query);

  if (candidates.length === 0) return null;

  const best = pickBestCandidate(item, candidates);

  if (!best) {
    console.log("🎮 CG no match:", query);
    return null;
  }

  const detailPrice = await fetchDetailPrice(best.url);
  const finalPrice = chooseFinalPrice(best.price, detailPrice);

  console.log("🎮 CG selected:", {
    title: best.title,
    listingPrice: best.price,
    detailPrice,
    finalPrice,
    url: best.url
  });

  return {
    price: Number(finalPrice.toFixed(2)),
    source: "chollo_games",
    confidence: computeConfidence(item, best.title),
    matchedTitle: best.title,
    matchedUrl: best.url,
    query
  };
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
      console.log("❌ CG fetch failed:", res.status, url);
      return null;
    }

    return await res.text();
  } catch (err) {
    console.log("❌ CG fetch error:", err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractCandidates(html: string): Candidate[] {
  const $ = cheerio.load(html);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  const selectors = [
    "li.product",
    ".product",
    ".type-product",
    ".product-small",
    ".wc-block-grid__product"
  ];

  for (const selector of selectors) {
    $(selector).each((_, el) => {
      const root = $(el);

      const title =
        root.find(".woocommerce-loop-product__title").first().text().trim() ||
        root.find(".product-title").first().text().trim() ||
        root.find("h2").first().text().trim() ||
        root.find("h3").first().text().trim() ||
        root.find("a").first().attr("title")?.trim() ||
        root.find("a").first().text().trim() ||
        "";

      const href = root.find("a").first().attr("href") || "";

      const priceText =
        root.find(".price ins .woocommerce-Price-amount").first().text().trim() ||
        root.find(".price .woocommerce-Price-amount").last().text().trim() ||
        root.find(".woocommerce-Price-amount").last().text().trim() ||
        root.find(".price").first().text().trim() ||
        root.text();

      const price = parseLastEuroPrice(priceText);

      if (!title || !href || price == null || price <= 0) return;

      const url = absolutize(href);
      const key = `${normalizeText(title)}|${price}|${url}`;

      if (seen.has(key)) return;
      seen.add(key);

      candidates.push({
        title: cleanTitle(title),
        price,
        url
      });
    });
  }

  return candidates;
}

async function fetchDetailPrice(url: string): Promise<number | null> {
  const html = await fetchHtml(url);
  if (!html) return null;

  const $ = cheerio.load(html);

  const priceText =
    $(".summary .price ins .woocommerce-Price-amount").first().text().trim() ||
    $(".summary .price .woocommerce-Price-amount").last().text().trim() ||
    $(".summary .woocommerce-Price-amount").last().text().trim() ||
    $("p.price .woocommerce-Price-amount").last().text().trim() ||
    $(".price").first().text().trim();

  return parseLastEuroPrice(priceText);
}

function pickBestCandidate(item: Item, candidates: Candidate[]): Candidate | null {
  const wanted = normalizeSearchText(item.name);
  const wantedTokens = wanted.split(" ").filter(Boolean);

  const platform = normalizeSearchText(item.platform ?? "");

  const scored = candidates.map((candidate) => {
    const title = normalizeSearchText(candidate.title);

    let score = similarityScore(wanted, title);

    if (title.includes(wanted)) score += 0.25;
    if (wantedTokens.length > 0 && wantedTokens.every((token) => title.includes(token))) {
      score += 0.2;
    }

    if (platform && title.includes(platform)) {
      score += 0.1;
    }

    return {
      candidate,
      score
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (!best || best.score < 0.3) return null;

  return best.candidate;
}

function chooseFinalPrice(listingPrice: number, detailPrice: number | null): number {
  if (!detailPrice || detailPrice <= 0) return listingPrice;

  const difference = Math.abs(detailPrice - listingPrice);
  const maxAllowedDifference = listingPrice * 0.25;

  if (difference <= maxAllowedDifference) return detailPrice;

  return listingPrice;
}

function parseLastEuroPrice(text: string | null | undefined): number | null {
  const value = String(text || "");
  const matches = [...value.matchAll(/(\d{1,5}(?:[.,]\d{2})?)\s*€/g)];

  if (matches.length > 0) {
    const last = matches[matches.length - 1]?.[1];
    return parseEuroPrice(last ?? null);
  }

  return parseEuroPrice(value);
}

function normalizeSearchText(value: string): string {
  return normalizeText(value)
    .replace(/\bpal\b/g, "")
    .replace(/\bes\b/g, "")
    .replace(/\bspanish\b/g, "")
    .replace(/\bcastellano\b/g, "")
    .replace(/\bsegunda\b/g, "")
    .replace(/\bmano\b/g, "")
    .replace(/\busado\b/g, "")
    .replace(/\bnuevo\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTitle(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/Añadir al carrito/gi, "")
    .replace(/Oferta/gi, "")
    .replace(/Agotado/gi, "")
    .trim();
}

function absolutize(href: string): string {
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  if (href.startsWith("/")) return `${BASE_URL}${href}`;
  return `${BASE_URL}/${href}`;
}

function computeConfidence(item: Item, matchedTitle: string): number {
  const wanted = normalizeSearchText(item.name);
  const matched = normalizeSearchText(matchedTitle);

  let confidence = 0.45 + similarityScore(wanted, matched) * 0.45;

  if (matched.includes(wanted)) confidence += 0.05;

  return Math.max(0.2, Math.min(0.92, Number(confidence.toFixed(2))));
}