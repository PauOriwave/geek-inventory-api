import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import {
  normalizeText,
  parseEuroPrice
} from "../utils";
import {
  buildSearchText,
  pickBestBySimilarity,
  computeConfidenceFromScore
} from "../scraper.utils";
import { ScraperSourceResult } from "../scraper.types";

type CexCandidate = {
  title: string;
  price: number;
  href?: string;
};

const CEX_BASE_URL = "https://es.webuy.com";

export async function getCexPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  const query = buildSearchText(item);
  if (!query) return null;

  const searchUrl = `${CEX_BASE_URL}/search?stext=${encodeURIComponent(query)}`;

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
      console.error("CEX fetch failed:", res.status);
      return null;
    }

    const html = await res.text();
    const candidates = extractCandidates(html);

    if (candidates.length === 0) {
      console.log("CEX no candidates:", query);
      return null;
    }

    const best = pickBestCandidate(item, candidates);

    if (!best) {
      console.log("CEX no match:", query);
      return null;
    }

    const confidence = computeConfidence(item, best.title);

    return {
      price: best.price,
      source: "cex",
      confidence,
      matchedTitle: best.title,
      matchedUrl: best.href,
      query
    };
  } catch (err) {
    console.error("CEX error:", err);
    return null;
  }
}

function extractCandidates(html: string): CexCandidate[] {
  const $ = cheerio.load(html);
  const results: CexCandidate[] = [];
  const unique = new Set<string>();

  const cardSelectors = [
    "[class*='product']",
    "[class*='search'] [class*='item']",
    "article",
    ".product-box",
    ".search-result"
  ];

  const priceSelectors = [
    "[class*='price']",
    ".price",
    ".salesPrice",
    ".buyPrice"
  ];

  const titleSelectors = [
    "[class*='title']",
    "h2",
    "h3",
    "a[title]",
    "a"
  ];

  for (const cardSelector of cardSelectors) {
    $(cardSelector).each((_, el) => {
      const root = $(el);

      const title = firstNonEmptyText(root, titleSelectors);
      const priceText = firstNonEmptyText(root, priceSelectors);
      const href = root.find("a[href]").first().attr("href") || undefined;

      const price = parseEuroPrice(priceText);

      if (!title || price == null || price <= 0) return;

      const key = `${normalizeText(title)}|${price}`;
      if (unique.has(key)) return;

      unique.add(key);

      results.push({
        title: title.trim(),
        price,
        href: href ? absolutize(href) : undefined
      });
    });
  }

  return results;
}

function firstNonEmptyText(
  root: cheerio.Cheerio<any>,
  selectors: string[]
): string | null {
  for (const selector of selectors) {
    const node = root.find(selector).first();

    if (!node || node.length === 0) continue;

    const text = node.attr("title")?.trim() || node.text()?.trim();

    if (text) return text;
  }

  return null;
}

function absolutize(href: string): string {
  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }

  if (href.startsWith("/")) {
    return `${CEX_BASE_URL}${href}`;
  }

  return `${CEX_BASE_URL}/${href}`;
}

function pickBestCandidate(
  item: Item,
  candidates: CexCandidate[]
): CexCandidate | null {
  return pickBestBySimilarity(item, candidates, 0.25);
}

function computeConfidence(item: Item, matchedTitle: string): number {
  const wanted = [item.name, item.platform ?? "", item.region ?? ""]
    .filter(Boolean)
    .join(" ");

  const baseScore = similarityScoreSafe(wanted, matchedTitle);
  return computeConfidenceFromScore(baseScore);
}

function similarityScoreSafe(a: string, b: string) {
  const aNorm = normalizeText(a);
  const bNorm = normalizeText(b);

  if (!aNorm || !bNorm) return 0;
  if (aNorm === bNorm) return 1;
  if (bNorm.includes(aNorm) || aNorm.includes(bNorm)) return 0.8;

  const aWords = new Set(aNorm.split(" ").filter(Boolean));
  const bWords = new Set(bNorm.split(" ").filter(Boolean));

  if (aWords.size === 0 || bWords.size === 0) return 0;

  let overlap = 0;
  for (const word of aWords) {
    if (bWords.has(word)) overlap++;
  }

  return overlap / Math.max(aWords.size, bWords.size);
}