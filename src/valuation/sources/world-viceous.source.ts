import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import { normalizeText, parseEuroPrice, similarityScore } from "../utils";
import { ScraperSourceResult } from "../scraper.types";

type Candidate = {
  title: string;
  price: number;
  url: string;
};

const BASE_URL = "https://store.worldviceous.com";
const REQUEST_TIMEOUT_MS = 15000;

export async function getWorldViceousPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (item.category !== "videogame") return null;

  const queries = buildSearchQueries(item.name);

  for (const query of queries) {
    const searchUrl = `${BASE_URL}/search?q=${encodeURIComponent(query)}`;

    console.log("🎮 WV Searching:", searchUrl);

    const html = await fetchHtml(searchUrl);
    if (!html) continue;

    console.log("🎮 WV html length:", html.length, "query:", query);

    const candidates = extractCandidates(html);

    console.log("🎮 WV candidates:", candidates.length, query);

    if (candidates.length === 0) continue;

    const best = pickBestCandidate(item, candidates);

    if (!best) {
      console.log("🎮 WV no match:", query);
      continue;
    }

    const detailPrice = await fetchDetailPrice(best.url);
    const finalPrice = chooseFinalPrice(best.price, detailPrice);

    console.log("🎮 WV selected:", {
      title: best.title,
      listingPrice: best.price,
      detailPrice,
      finalPrice,
      url: best.url
    });

    return {
      price: Number(finalPrice.toFixed(2)),
      source: "world_viceous",
      confidence: computeConfidence(item, best.title),
      matchedTitle: best.title,
      matchedUrl: best.url,
      query
    };
  }

  return null;
}

/* ---------------- SEARCH STRATEGY ---------------- */

function buildSearchQueries(name: string): string[] {
  const clean = name.trim();

  const parts = clean.split(" ");

  return [
    clean,
    parts.slice(0, 4).join(" "),
    parts.slice(0, 3).join(" "),
    parts.slice(0, 2).join(" "),
    parts[0]
  ];
}

/* ---------------- FETCH ---------------- */

async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    if (!res.ok) {
      console.log("❌ WV fetch failed:", res.status);
      return null;
    }

    return await res.text();
  } catch (err) {
    console.log("❌ WV fetch error:", err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/* ---------------- CANDIDATES ---------------- */

function extractCandidates(html: string): Candidate[] {
  const $ = cheerio.load(html);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  $("a[href*='/products/']").each((_, el) => {
    const link = $(el);

    const href = link.attr("href");
    if (!href) return;

    const url = absolutize(href);

    const title =
      link.find("span").text().trim() ||
      link.text().trim() ||
      link.attr("title") ||
      "";

    const priceText =
      link.closest("div").find(".price").first().text().trim() ||
      link.closest("div").text();

    const price = parseLastEuroPrice(priceText);

    if (!title || price == null || price <= 0) return;

    const key = `${normalizeText(title)}|${price}|${url}`;
    if (seen.has(key)) return;
    seen.add(key);

    candidates.push({
      title: cleanTitle(title),
      price,
      url
    });
  });

  return candidates;
}

/* ---------------- DETAIL ---------------- */

async function fetchDetailPrice(url: string): Promise<number | null> {
  const html = await fetchHtml(url);
  if (!html) return null;

  const $ = cheerio.load(html);

  const priceText =
    $(".price-item--sale").first().text().trim() ||
    $(".price-item--regular").first().text().trim() ||
    $(".price").first().text().trim();

  return parseLastEuroPrice(priceText);
}

/* ---------------- MATCHING ---------------- */

function pickBestCandidate(item: Item, candidates: Candidate[]): Candidate | null {
  const wanted = normalizeSearchText(item.name);
  const wantedTokens = wanted.split(" ").filter(Boolean);

  const platform = normalizeSearchText(item.platform ?? "");

  const scored = candidates.map((candidate) => {
    const title = normalizeSearchText(candidate.title);

    let score = similarityScore(wanted, title);

    if (title.includes(wanted)) score += 0.25;

    if (wantedTokens.every((t) => title.includes(t))) {
      score += 0.2;
    }

    if (platform && title.includes(platform)) {
      score += 0.1;
    }

    return { candidate, score };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log(
    "🎮 WV top candidates:",
    scored.slice(0, 5).map((s) => ({
      title: s.candidate.title,
      price: s.candidate.price,
      score: s.score
    }))
  );

  if (!scored[0] || scored[0].score < 0.3) return null;

  return scored[0].candidate;
}

/* ---------------- PRICE ---------------- */

function chooseFinalPrice(listingPrice: number, detailPrice: number | null): number {
  if (!detailPrice || detailPrice <= 0) return listingPrice;

  const diff = Math.abs(detailPrice - listingPrice);

  if (diff <= listingPrice * 0.25) return detailPrice;

  return listingPrice;
}

function parseLastEuroPrice(text: string | null | undefined): number | null {
  const value = String(text || "");
  const matches = [...value.matchAll(/(\d+(?:[.,]\d{2})?)\s*€/g)];

  if (matches.length > 0) {
    return parseEuroPrice(matches[matches.length - 1][1]);
  }

  return parseEuroPrice(value);
}

/* ---------------- UTILS ---------------- */

function normalizeSearchText(value: string): string {
  return normalizeText(value)
    .replace(/\bpal\b/g, "")
    .replace(/\bnew\b/g, "")
    .replace(/\bused\b/g, "")
    .trim();
}

function cleanTitle(value: string): string {
  return value
    .replace(/Sale price/gi, "")
    .replace(/Regular price/gi, "")
    .replace(/Sold out/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function absolutize(href: string): string {
  if (href.startsWith("http")) return href;
  return `${BASE_URL}${href}`;
}

function computeConfidence(item: Item, matchedTitle: string): number {
  const wanted = normalizeSearchText(item.name);
  const matched = normalizeSearchText(matchedTitle);

  let confidence = 0.45 + similarityScore(wanted, matched) * 0.45;

  if (matched.includes(wanted)) confidence += 0.05;

  return Math.max(0.2, Math.min(0.92, Number(confidence.toFixed(2))));
}