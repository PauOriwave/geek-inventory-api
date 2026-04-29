import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import { normalizeText, parseEuroPrice, similarityScore } from "../utils";
import { ScraperSourceResult } from "../scraper.types";

type Candidate = {
  title: string;
  price: number | null;
  url: string;
};

const BASE_URL = "https://www.normacomics.com";
const REQUEST_TIMEOUT_MS = 15000;

// 🔴 CAMBIO CLAVE → SOLO comics
const SUPPORTED_CATEGORIES = new Set(["comic"]);

export async function getNormaComicsPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (!SUPPORTED_CATEGORIES.has(item.category)) return null;

  const queries = buildSearchQueries(item.name);

  for (const query of queries) {
    const searchUrl = `${BASE_URL}/catalogsearch/result/?q=${encodeURIComponent(
      query
    )}`;

    console.log("📚 Norma Searching:", searchUrl);

    const html = await fetchHtml(searchUrl);
    if (!html) continue;

    console.log("📚 Norma html length:", html.length, "query:", query);

    const candidates = extractCandidates(html);

    console.log("📚 Norma candidates:", candidates.length, query);

    if (candidates.length === 0) {
      logHtmlDiagnostics(html);
      continue;
    }

    const best = pickBestCandidate(item, candidates);

    if (!best) {
      console.log("📚 Norma candidates found but no match:", query);
      continue;
    }

    const detail = await fetchDetail(best.url);
    const detailPrice = detail?.price ?? null;
    const detailTitle = detail?.title ?? null;

    const finalPrice = chooseFinalPrice(best.price, detailPrice);

    if (!finalPrice || finalPrice <= 0) {
      console.log("📚 Norma matched product but no usable price:", {
        title: best.title,
        url: best.url,
        listingPrice: best.price,
        detailPrice
      });
      continue;
    }

    const matchedTitle = detailTitle || best.title;

    console.log("📚 Norma selected:", {
      title: matchedTitle,
      listingPrice: best.price,
      detailPrice,
      finalPrice,
      url: best.url
    });

    return {
      price: Number(finalPrice.toFixed(2)),
      source: "norma_comics",
      confidence: computeConfidence(item, matchedTitle),
      matchedTitle,
      matchedUrl: best.url,
      query
    };
  }

  return null;
}

// =======================
// RESTO SIN CAMBIOS
// =======================

function buildSearchQueries(name: string): string[] {
  const clean = cleanQuery(name);
  const parts = clean.split(" ").filter(Boolean);

  return [
    clean,
    parts.slice(0, 6).join(" "),
    parts.slice(0, 5).join(" "),
    parts.slice(0, 4).join(" "),
    parts.slice(0, 3).join(" ")
  ]
    .map((query) => query.trim())
    .filter(Boolean)
    .filter((query, index, arr) => arr.indexOf(query) === index);
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
      console.log("❌ Norma fetch failed:", res.status, url);
      return null;
    }

    return await res.text();
  } catch (err) {
    console.log("❌ Norma fetch error:", err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractCandidates(html: string): Candidate[] {
  const $ = cheerio.load(html);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_, el) => {
    const link = $(el);
    const href = link.attr("href") || "";

    if (!href.includes(".html")) return;

    const title =
      link.text().trim() ||
      link.attr("title")?.trim() ||
      link.find("img").attr("alt") ||
      "";

    const priceText =
      link.closest("li, div, article").find(".price").text().trim() ||
      link.closest("li, div, article").text();

    const price = parsePrice(priceText);

    if (!title || !href) return;

    const url = absolutize(href);
    const key = `${normalizeText(title)}|${price ?? "null"}|${url}`;

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

async function fetchDetail(
  url: string
): Promise<{ title: string | null; price: number | null } | null> {
  const html = await fetchHtml(url);
  if (!html) return null;

  const $ = cheerio.load(html);

  const title =
    $("h1").first().text().trim() ||
    $("meta[property='og:title']").attr("content") ||
    null;

  const price =
    parsePrice($(".price").first().text()) ||
    parsePrice($("meta[property='product:price:amount']").attr("content")) ||
    null;

  return {
    title,
    price
  };
}

function pickBestCandidate(item: Item, candidates: Candidate[]): Candidate | null {
  const wanted = normalizeSearchText(item.name);
  const wantedTokens = wanted.split(" ").filter(Boolean);

  const scored = candidates.map((candidate) => {
    const title = normalizeSearchText(candidate.title);

    let score = similarityScore(wanted, title);

    if (title.includes(wanted)) score += 0.25;

    if (wantedTokens.every((token) => title.includes(token))) {
      score += 0.2;
    }

    return { candidate, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (!best || best.score < 0.45) return null;

  return best.candidate;
}

function chooseFinalPrice(
  listingPrice: number | null,
  detailPrice: number | null
): number | null {
  if (!detailPrice) return listingPrice;
  return detailPrice;
}

function parsePrice(text: string | null | undefined): number | null {
  const value = String(text || "");
  const matches = [...value.matchAll(/(\d{1,5}(?:[.,]\d{2})?)\s*€/g)];

  if (matches.length > 0) {
    return parseEuroPrice(matches[matches.length - 1][1]);
  }

  return parseEuroPrice(value);
}

function normalizeSearchText(value: string): string {
  return normalizeText(value).replace(/\s+/g, " ").trim();
}

function cleanQuery(value: string): string {
  return String(value || "").trim();
}

function cleanTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function absolutize(href: string): string {
  if (href.startsWith("http")) return href;
  if (href.startsWith("/")) return `${BASE_URL}${href}`;
  return `${BASE_URL}/${href}`;
}

function computeConfidence(item: Item, matchedTitle: string): number {
  const wanted = normalizeSearchText(item.name);
  const matched = normalizeSearchText(matchedTitle);

  return Number(
    Math.max(0.2, Math.min(0.92, similarityScore(wanted, matched))).toFixed(2)
  );
}

function logHtmlDiagnostics(html: string) {
  console.log("📚 Norma diagnostics:", {
    containsPrice: html.includes("€"),
    containsProduct: html.includes("product")
  });
}