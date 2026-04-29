import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import { normalizeText, parseEuroPrice, similarityScore } from "../utils";
import { ScraperSourceResult } from "../scraper.types";

type Candidate = {
  title: string;
  price: number | null;
  url: string;
};

const BASE_URL = "https://www.casadellibro.com";
const REQUEST_TIMEOUT_MS = 15000;

export async function getCasaDelLibroPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (item.category !== "book") return null;

  const query = cleanQuery(item.name);
  if (!query) return null;

  const searchUrl = `${BASE_URL}/busqueda-libros?busqueda=${encodeURIComponent(query)}`;

  console.log("📚 CDL Searching:", searchUrl);

  const html = await fetchHtml(searchUrl);
  if (!html) return null;

  console.log("📚 CDL html length:", html.length);

  const candidates = extractCandidates(html);

  console.log("📚 CDL candidates:", candidates.length);

  if (candidates.length === 0) {
    logHtmlDiagnostics(html);
    return null;
  }

  const best = pickBestCandidate(item, candidates);

  if (!best) {
    console.log("📚 CDL no match");
    return null;
  }

  const detail = await fetchDetail(best.url);

  if (!detail?.price || detail.price <= 0) {
    console.log("📚 CDL matched but no price:", best);
    return null;
  }

  const matchedTitle = detail.title || best.title;
  const confidence = computeConfidence(item, matchedTitle);

  console.log("📚 CDL selected:", {
    title: matchedTitle,
    price: detail.price,
    confidence,
    url: best.url
  });

  return {
    price: Number(detail.price.toFixed(2)),
    source: "casa_del_libro",
    confidence,
    matchedTitle,
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
      console.log("❌ CDL fetch failed:", res.status, url);
      return null;
    }

    return await res.text();
  } catch (err) {
    console.log("❌ CDL fetch error:", err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractCandidates(html: string): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  const normalizedHtml = decodeHtml(html)
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/%2F/gi, "/");

  const patterns = [
    /https?:\/\/www\.casadellibro\.com\/(?:libro|ebook)-[^"'<>\\\s]+\/\d+\/\d+/gi,
    /\/(?:libro|ebook)-[^"'<>\\\s]+\/\d+\/\d+/gi,
    /https?:\/\/www\.casadellibro\.com\/vender-libro\/[^"'<>\\\s]+\/\d+\/\d+/gi,
    /\/vender-libro\/[^"'<>\\\s]+\/\d+\/\d+/gi
  ];

  for (const pattern of patterns) {
    for (const match of normalizedHtml.matchAll(pattern)) {
      const rawUrl = match[0];
      const url = absolutize(rawUrl);

      if (!looksLikeProductUrl(url)) continue;

      const title = titleFromProductUrl(url);
      if (!title) continue;

      const key = `${normalizeText(title)}|${url}`;
      if (seen.has(key)) continue;
      seen.add(key);

      candidates.push({
        title,
        price: null,
        url
      });
    }
  }

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
    $("meta[property='og:title']").attr("content")?.trim() ||
    $("[itemprop='name']").first().text().trim() ||
    titleFromProductUrl(url) ||
    null;

  const price =
    parsePrice($("#p-pf-f").first().text().trim()) ??
    parsePrice($("meta[property='product:price:amount']").attr("content")) ??
    parsePrice($("meta[itemprop='price']").attr("content")) ??
    parsePrice($("[itemprop='price']").first().attr("content")) ??
    parsePrice($("[itemprop='price']").first().text().trim()) ??
    parsePrice($("[class*='price']").first().text().trim()) ??
    extractPriceFromJson(html) ??
    null;

  console.log("📚 CDL detail parsed:", {
    url,
    title,
    price
  });

  return {
    title: title ? cleanTitle(title) : null,
    price
  };
}

function pickBestCandidate(item: Item, candidates: Candidate[]): Candidate | null {
  const wanted = normalizeSearchText(item.name);
  const importantTokens = getImportantTokens(wanted);

  console.log(
    "📚 CDL raw candidates:",
    candidates.slice(0, 20).map((candidate) => ({
      title: candidate.title,
      url: candidate.url
    }))
  );

  const filtered = candidates.filter((candidate) => {
    const title = normalizeSearchText(candidate.title);
    const url = normalizeSearchText(candidate.url);

    return importantTokens.every(
      (token) => title.includes(token) || url.includes(token)
    );
  });

  console.log("📚 CDL filtered candidates:", filtered.length);

  const scored = filtered.map((candidate) => {
    const title = normalizeSearchText(candidate.title);
    const urlSlug = normalizeSearchText(candidate.url).replace(/\s+/g, "-");

    let score = similarityScore(wanted, title);

    if (title.includes(wanted)) score += 0.3;
    if (urlSlug.includes(wanted.replace(/\s+/g, "-"))) score += 0.25;

    return {
      candidate,
      score
    };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log(
    "📚 CDL top:",
    scored.slice(0, 8).map((s) => ({
      title: s.candidate.title,
      score: Number(s.score.toFixed(2)),
      url: s.candidate.url
    }))
  );

  const best = scored[0];

  if (!best || best.score < 0.45) return null;

  return best.candidate;
}

function parsePrice(text: string | null | undefined): number | null {
  const value = String(text || "").trim();

  if (!value) return null;

  const numeric = Number(value.replace(",", "."));

  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  const matches = [...value.matchAll(/(\d{1,5}(?:[.,]\d{2})?)\s*€/g)];

  if (matches.length > 0) {
    const last = matches[matches.length - 1]?.[1];
    return parseEuroPrice(last ?? null);
  }

  return parseEuroPrice(value);
}

function extractPriceFromJson(html: string): number | null {
  const matches = [
    ...html.matchAll(/"price"\s*:\s*"?(\d+(?:[.,]\d+)?)"?/g),
    ...html.matchAll(/"salePrice"\s*:\s*"?(\d+(?:[.,]\d+)?)"?/g),
    ...html.matchAll(/"finalPrice"\s*:\s*"?(\d+(?:[.,]\d+)?)"?/g)
  ];

  const prices = matches
    .map((match) => Number(String(match[1]).replace(",", ".")))
    .filter((price) => Number.isFinite(price) && price > 0 && price < 500)
    .sort((a, b) => b - a);

  return prices[0] ?? null;
}

function titleFromProductUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);

    let slug = "";

    if (parts[0] === "vender-libro") {
      slug = parts[1] || "";
    } else {
      slug = parts[0] || "";
    }

    return slug
      .replace(/^libro-/, "")
      .replace(/^ebook-/, "")
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
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
    "the"
  ]);

  return normalizedText
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length > 3)
    .filter((token) => !stopWords.has(token));
}

function normalizeSearchText(value: string): string {
  return normalizeText(value)
    .replace(/\bedicion\b/g, "")
    .replace(/\bedición\b/g, "")
    .replace(/\bespecial\b/g, "")
    .replace(/\bvolumen\b/g, "")
    .replace(/\bvol\b/g, "")
    .replace(/\btomo\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanQuery(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTitle(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/Comprar/gi, "")
    .replace(/Ver ficha/gi, "")
    .replace(/Oferta/gi, "")
    .trim();
}

function looksLikeProductUrl(url: string): boolean {
  const normalized = url.toLowerCase();

  if (!normalized.startsWith("http")) return false;

  if (normalized.includes("/customer/")) return false;
  if (normalized.includes("/checkout/")) return false;
  if (normalized.includes("/wishlist/")) return false;
  if (normalized.includes("/busqueda")) return false;
  if (normalized.includes("/libros-ebooks/")) return false;

  return (
    normalized.includes("/libro-") ||
    normalized.includes("/ebook-") ||
    normalized.includes("/vender-libro/")
  );
}

function logHtmlDiagnostics(html: string) {
  const normalizedHtml = decodeHtml(html)
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/%2F/gi, "/");

  const productUrlMatches = [
    ...(normalizedHtml.match(
      /https?:\/\/www\.casadellibro\.com\/(?:libro|ebook)-[^"'<>\\\s]+\/\d+\/\d+/gi
    ) ?? []),
    ...(normalizedHtml.match(
      /\/(?:libro|ebook)-[^"'<>\\\s]+\/\d+\/\d+/gi
    ) ?? []),
    ...(normalizedHtml.match(
      /\/vender-libro\/[^"'<>\\\s]+\/\d+\/\d+/gi
    ) ?? [])
  ];

  console.log("📚 CDL diagnostics:", {
    containsLibroUrl: normalizedHtml.includes("/libro-"),
    containsVenderLibroUrl: normalizedHtml.includes("/vender-libro/"),
    containsKafkaEnLaOrilla: normalizedHtml.includes("kafka-en-la-orilla"),
    containsEuro: normalizedHtml.includes("€"),
    sampleProductUrls: productUrlMatches.slice(0, 10)
  });
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function absolutize(href: string): string {
  if (!href) return "";
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