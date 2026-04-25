import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import { normalizeText, parseEuroPrice, similarityScore } from "../utils";
import {
  buildSearchText,
  pickBestBySimilarity,
  computeConfidenceFromScore
} from "../scraper.utils";
import { ScraperSourceResult } from "../scraper.types";

type JuegosMesaRedondaCandidate = {
  title: string;
  price: number;
  href?: string;
};

const JMR_BASE_URL = "https://juegosdelamesaredonda.com";
const REQUEST_TIMEOUT_MS = 15000;

export async function getJuegosMesaRedondaPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (item.category !== "boardgame") {
    return null;
  }

  const query = buildSearchText(item);
  if (!query) return null;

  const searchUrl = `${JMR_BASE_URL}/search?controller=search&s=${encodeURIComponent(
    query
  )}`;

  try {
    const html = await fetchHtml(searchUrl);

    if (!html) {
      return null;
    }

    let candidates = extractCandidates(html);

    if (candidates.length === 0) {
      const secondHandUrl = `${JMR_BASE_URL}/158-segunda-mano`;
      const secondHandHtml = await fetchHtml(secondHandUrl);

      if (secondHandHtml) {
        candidates = extractCandidates(secondHandHtml);
      }
    }

    console.log("JMR candidates:", candidates.length, query);

    if (candidates.length === 0) {
      console.log("JMR no candidates:", query);
      return null;
    }

    const best = pickBestCandidate(item, candidates);

    if (!best) {
      console.log("JMR no match:", query);
      return null;
    }

    const confidence = computeConfidence(item, best.title);

    return {
      price: best.price,
      source: "juegos_mesa_redonda",
      confidence,
      matchedTitle: best.title,
      matchedUrl: best.href,
      query
    };
  } catch (err) {
    console.error("JMR error:", err);
    return null;
  }
}

async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Referer: JMR_BASE_URL
      }
    });

    if (!res.ok) {
      console.error("JMR fetch failed:", res.status, url);
      return null;
    }

    return await res.text();
  } catch (error) {
    console.error("JMR fetch error:", error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractCandidates(html: string): JuegosMesaRedondaCandidate[] {
  const $ = cheerio.load(html);
  const results: JuegosMesaRedondaCandidate[] = [];
  const seen = new Set<string>();

  extractProductCards($, results, seen);
  extractJsonLdProducts($, results, seen);

  return results;
}

function extractProductCards(
  $: cheerio.CheerioAPI,
  results: JuegosMesaRedondaCandidate[],
  seen: Set<string>
) {
  const cardSelectors = [
    ".product-miniature",
    ".js-product-miniature",
    "article.product-miniature",
    "[data-id-product]",
    ".product",
    "article",
    "li"
  ];

  const titleSelectors = [
    ".product-title a",
    ".product-title",
    "h1",
    "h2",
    "h3",
    "a[title]",
    "a"
  ];

  const priceSelectors = [
    ".price",
    ".product-price",
    ".current-price",
    "[itemprop='price']",
    "[class*='price']"
  ];

  for (const cardSelector of cardSelectors) {
    $(cardSelector).each((_, el) => {
      const root = $(el);

      const title = firstNonEmptyText(root, titleSelectors);

      const priceText =
        firstNonEmptyText(root, priceSelectors) ||
        root.text();

      const href =
        root.find("a[href]").first().attr("href") ||
        root.attr("href") ||
        undefined;

      addCandidate({
        title,
        priceText,
        href,
        results,
        seen
      });
    });
  }
}

function extractJsonLdProducts(
  $: cheerio.CheerioAPI,
  results: JuegosMesaRedondaCandidate[],
  seen: Set<string>
) {
  $("script[type='application/ld+json']").each((_, el) => {
    const raw = $(el).text();

    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];

      for (const node of nodes) {
        extractJsonLdNode(node, results, seen);
      }
    } catch {
      return;
    }
  });
}

function extractJsonLdNode(
  node: any,
  results: JuegosMesaRedondaCandidate[],
  seen: Set<string>
) {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const child of node) {
      extractJsonLdNode(child, results, seen);
    }
    return;
  }

  if (node["@graph"]) {
    extractJsonLdNode(node["@graph"], results, seen);
  }

  const type = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];

  if (type.includes("Product")) {
    const title = typeof node.name === "string" ? node.name : null;
    const href = typeof node.url === "string" ? node.url : undefined;

    const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;

    const rawPrice =
      offer?.price ??
      offer?.lowPrice ??
      offer?.highPrice ??
      node.price ??
      null;

    const priceText = rawPrice != null ? String(rawPrice) : null;

    addCandidate({
      title,
      priceText,
      href,
      results,
      seen
    });
  }
}

function addCandidate(input: {
  title: string | null;
  priceText: string | null;
  href?: string;
  results: JuegosMesaRedondaCandidate[];
  seen: Set<string>;
}) {
  const title = cleanTitle(input.title);
  const price = parseEuroPrice(input.priceText);

  if (!title || price == null || price <= 0) return;

  const key = `${normalizeText(title)}|${price}`;

  if (input.seen.has(key)) return;

  input.seen.add(key);

  input.results.push({
    title,
    price,
    href: input.href ? absolutize(input.href) : undefined
  });
}

function pickBestCandidate(
  item: Item,
  candidates: JuegosMesaRedondaCandidate[]
): JuegosMesaRedondaCandidate | null {
  const wanted = normalizeText(item.name);
  const strictMatch = candidates.find((candidate) => {
    const title = normalizeText(candidate.title);

    return (
      title === wanted ||
      title.includes(wanted) ||
      wanted.includes(title)
    );
  });

  if (strictMatch) {
    return strictMatch;
  }

  return pickBestBySimilarity(item, candidates, 0.15);
}

function firstNonEmptyText(
  root: cheerio.Cheerio<any>,
  selectors: string[]
): string | null {
  for (const selector of selectors) {
    const node = root.find(selector).first();

    if (!node || node.length === 0) continue;

    const text =
      node.attr("title")?.trim() ||
      node.attr("content")?.trim() ||
      node.text()?.trim();

    if (text) return text;
  }

  return null;
}

function cleanTitle(value: string | null): string | null {
  if (!value) return null;

  const cleaned = value
    .replace(/\s+/g, " ")
    .replace(/Añadir a la cesta/gi, "")
    .replace(/En stock/gi, "")
    .replace(/Fuera de stock/gi, "")
    .replace(/Segunda mano/gi, "")
    .replace(/\(\s*\)/g, "")
    .trim();

  if (cleaned.length < 3) return null;

  return cleaned;
}

function absolutize(href: string): string {
  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }

  if (href.startsWith("/")) {
    return `${JMR_BASE_URL}${href}`;
  }

  return `${JMR_BASE_URL}/${href}`;
}

function computeConfidence(item: Item, matchedTitle: string): number {
  const wanted = [item.name, item.platform ?? "", item.region ?? ""]
    .filter(Boolean)
    .join(" ");

  let score = similarityScore(wanted, matchedTitle);

  const normalizedTitle = normalizeText(matchedTitle);

  if (normalizedTitle.includes(normalizeText(item.name))) {
    score += 0.2;
  }

  if (normalizedTitle.includes("castellano") || normalizedTitle.includes("espanol")) {
    score += 0.04;
  }

  return computeConfidenceFromScore(Math.min(score, 1));
}