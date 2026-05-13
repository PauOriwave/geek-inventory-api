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

    const matchedTitle = detailTitle || best.title;

    if (!isSameComicVolume(item.name, matchedTitle)) {
      console.log("📚 Norma rejected by volume mismatch:", {
        wanted: item.name,
        matchedTitle,
        url: best.url
      });
      continue;
    }

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

    const confidence = computeConfidence(item, matchedTitle);

    console.log("📚 Norma selected:", {
      title: matchedTitle,
      listingPrice: best.price,
      detailPrice,
      finalPrice,
      confidence,
      url: best.url
    });

    return {
      price: Number(finalPrice.toFixed(2)),
      currency: "EUR",
      source: "norma_comics",
      confidence,
      matchedTitle,
      matchedUrl: best.url,
      query,
      metadata: {
        provider: "norma_comics",
        currency: "EUR",
        listingPrice: best.price,
        detailPrice,
        finalPrice,
        category: item.category,
        url: best.url,
        volumeCheck: {
          wantedVolume: extractVolumeNumber(item.name),
          matchedVolume: extractVolumeNumber(matchedTitle),
          passed: isSameComicVolume(item.name, matchedTitle)
        }
      }
    };
  }

  return null;
}

function buildSearchQueries(name: string): string[] {
  const clean = cleanQuery(name);
  const normalized = normalizeSearchText(clean);
  const baseWithoutVolume = removeTrailingVolume(clean);
  const parts = clean.split(" ").filter(Boolean);

  const queries = [
    clean,
    normalized,
    baseWithoutVolume,
    parts.slice(0, 6).join(" "),
    parts.slice(0, 5).join(" "),
    parts.slice(0, 4).join(" "),
    parts.slice(0, 3).join(" ")
  ];

  return queries
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

    if (!isProductUrl(url)) return;

    const cleanCandidateTitle = cleanTitle(title);

    if (!cleanCandidateTitle) return;

    const key = `${normalizeText(cleanCandidateTitle)}|${price ?? "null"}|${url}`;

    if (seen.has(key)) return;
    seen.add(key);

    candidates.push({
      title: cleanCandidateTitle,
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
    cleanTitle($("h1").first().text()) ||
    cleanTitle($("meta[property='og:title']").attr("content") || "") ||
    null;

  const price =
    parsePrice($(".price").first().text()) ??
    parsePrice($("meta[property='product:price:amount']").attr("content")) ??
    null;

  return {
    title,
    price
  };
}

function pickBestCandidate(item: Item, candidates: Candidate[]): Candidate | null {
  const wanted = normalizeSearchText(item.name);
  const wantedBase = normalizeSearchText(removeTrailingVolume(item.name));
  const wantedTokens = getImportantTokens(wantedBase);
  const wantedVolume = extractVolumeNumber(item.name);

  const filtered = candidates.filter((candidate) => {
    const title = normalizeSearchText(candidate.title);

    if (wantedVolume && !isSameComicVolume(item.name, candidate.title)) {
      return false;
    }

    if (wantedTokens.length > 0) {
      return wantedTokens.every((token) => title.includes(token));
    }

    return true;
  });

  console.log(
    "📚 Norma filtered candidates:",
    filtered.slice(0, 12).map((candidate) => ({
      title: candidate.title,
      price: candidate.price,
      volume: extractVolumeNumber(candidate.title),
      url: candidate.url
    }))
  );

  if (filtered.length === 0) return null;

  const scored = filtered.map((candidate) => {
    const title = normalizeSearchText(candidate.title);
    const candidateBase = normalizeSearchText(removeTrailingVolume(candidate.title));

    let score = similarityScore(wantedBase || wanted, candidateBase || title);

    if (title === wanted) score += 0.7;
    if (title.includes(wanted)) score += 0.45;
    if (candidateBase === wantedBase) score += 0.5;
    if (candidateBase.includes(wantedBase)) score += 0.25;

    if (wantedTokens.every((token) => title.includes(token))) {
      score += 0.25;
    }

    if (wantedVolume && extractVolumeNumber(candidate.title) === wantedVolume) {
      score += 0.5;
    }

    if (candidate.price && candidate.price > 0) {
      score += 0.05;
    }

    return { candidate, score };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log(
    "📚 Norma top candidates:",
    scored.slice(0, 8).map((entry) => ({
      title: entry.candidate.title,
      price: entry.candidate.price,
      volume: extractVolumeNumber(entry.candidate.title),
      score: Number(entry.score.toFixed(2)),
      url: entry.candidate.url
    }))
  );

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
    return parseEuroPrice(matches[matches.length - 1]?.[1] ?? null);
  }

  return parseEuroPrice(value);
}

function isSameComicVolume(wantedTitle: string, candidateTitle: string): boolean {
  const wantedVolume = extractVolumeNumber(wantedTitle);
  const candidateVolume = extractVolumeNumber(candidateTitle);

  if (!wantedVolume) return true;
  if (!candidateVolume) return false;

  return wantedVolume === candidateVolume;
}

function extractVolumeNumber(value: string): string | null {
  const normalized = normalizeSearchText(value)
    .replace(/[ºª]/g, "")
    .replace(/[#]/g, " ");

  const explicit = normalized.match(
    /\b(?:tomo|volumen|volume|vol|num|n|numero|número)\s*\.?\s*(\d{1,4})\b/i
  );

  if (explicit?.[1]) return normalizeVolumeNumber(explicit[1]);

  const trailing = normalized.match(/\b(\d{1,4})\s*$/);

  if (trailing?.[1]) return normalizeVolumeNumber(trailing[1]);

  const urlLike = normalized.match(/-(\d{1,4})(?:\.html)?$/);

  if (urlLike?.[1]) return normalizeVolumeNumber(urlLike[1]);

  return null;
}

function normalizeVolumeNumber(value: string): string {
  const numeric = Number(value);

  if (Number.isFinite(numeric)) {
    return String(numeric);
  }

  return String(value).replace(/^0+/, "") || value;
}

function removeTrailingVolume(value: string): string {
  return String(value || "")
    .replace(
      /\b(?:tomo|volumen|volume|vol|num|n|numero|número)\s*\.?\s*\d{1,4}\b/gi,
      ""
    )
    .replace(/\s+\d{1,4}\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getImportantTokens(normalizedText: string): string[] {
  const stopWords = new Set([
    "el",
    "la",
    "los",
    "las",
    "un",
    "una",
    "unos",
    "unas",
    "de",
    "del",
    "en",
    "a",
    "al",
    "y",
    "o",
    "por",
    "para",
    "con",
    "sin",
    "the",
    "comic",
    "comics",
    "manga",
    "tomo",
    "vol",
    "volume",
    "volumen",
    "num",
    "numero",
    "número"
  ]);

  return normalizedText
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length > 1)
    .filter((token) => !stopWords.has(token))
    .filter((token) => !/^\d+$/.test(token));
}

function normalizeSearchText(value: string): string {
  return normalizeText(value)
    .replace(/[™®©]/g, "")
    .replace(/[:_()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanQuery(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanTitle(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/Comprar/gi, "")
    .replace(/Añadir al carrito/gi, "")
    .replace(/Vista rápida/gi, "")
    .replace(/Oferta/gi, "")
    .replace(/Agotado/gi, "")
    .trim();
}

function absolutize(href: string): string {
  if (href.startsWith("http")) return href;
  if (href.startsWith("/")) return `${BASE_URL}${href}`;
  return `${BASE_URL}/${href}`;
}

function isProductUrl(url: string): boolean {
  const normalized = url.toLowerCase();

  if (!normalized.startsWith("http")) return false;
  if (!normalized.includes("normacomics.com")) return false;
  if (!normalized.endsWith(".html")) return false;

  if (normalized.includes("/catalogsearch/")) return false;
  if (normalized.includes("/checkout/")) return false;
  if (normalized.includes("/customer/")) return false;
  if (normalized.includes("/wishlist/")) return false;

  return true;
}

function computeConfidence(item: Item, matchedTitle: string): number {
  const wanted = normalizeSearchText(item.name);
  const wantedBase = normalizeSearchText(removeTrailingVolume(item.name));
  const matched = normalizeSearchText(matchedTitle);
  const matchedBase = normalizeSearchText(removeTrailingVolume(matchedTitle));

  let confidence = 0.4;

  confidence += similarityScore(wantedBase || wanted, matchedBase || matched) * 0.35;

  if (matched === wanted) confidence += 0.2;
  if (matchedBase === wantedBase) confidence += 0.15;

  if (isSameComicVolume(item.name, matchedTitle)) {
    confidence += 0.12;
  } else {
    confidence -= 0.35;
  }

  return Number(Math.max(0.2, Math.min(0.92, confidence)).toFixed(2));
}

function logHtmlDiagnostics(html: string) {
  console.log("📚 Norma diagnostics:", {
    containsPrice: html.includes("€"),
    containsProduct: html.includes("product")
  });
}