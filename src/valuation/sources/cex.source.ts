import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import { normalizeText, parseEuroPrice, similarityScore } from "../utils";
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
const REQUEST_TIMEOUT_MS = 15000;

export async function getCexPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  const query = buildSearchText(item);
  if (!query) return null;

  const searchUrl = `${CEX_BASE_URL}/search?stext=${encodeURIComponent(query)}`;

  try {
    const html = await fetchCexHtml(searchUrl);

    if (!html) {
      return null;
    }

    const candidates = extractCandidates(html);

    console.log("CEX candidates:", candidates.length, query);

    if (candidates.length === 0) {
      console.log("CEX no candidates:", query);
      return null;
    }

    const best = pickBestBySimilarity(item, candidates, 0.25);

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

async function fetchCexHtml(url: string): Promise<string | null> {
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
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Connection: "keep-alive",
        Referer: "https://es.webuy.com/",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1"
      }
    });

    if (!res.ok) {
      console.error("CEX fetch failed:", res.status);
      return null;
    }

    return await res.text();
  } catch (error) {
    console.error("CEX fetch error:", error);
    return null;
  } finally {
    clearTimeout(timeout);
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
    ".search-result",
    "li",
    ".card"
  ];

  const priceSelectors = [
    "[class*='price']",
    ".price",
    ".salesPrice",
    ".buyPrice",
    "[data-testid*='price']"
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

function computeConfidence(item: Item, matchedTitle: string): number {
  const wanted = [item.name, item.platform ?? "", item.region ?? ""]
    .filter(Boolean)
    .join(" ");

  let score = similarityScore(wanted, matchedTitle);

  const normalizedTitle = normalizeText(matchedTitle);

  if (item.platform) {
    const platform = normalizeText(item.platform);

    if (normalizedTitle.includes(platform)) {
      score += 0.1;
    }
  }

  if (item.region) {
    const region = normalizeText(item.region);

    if (normalizedTitle.includes(region)) {
      score += 0.05;
    }
  }

  return computeConfidenceFromScore(Math.min(score, 1));
}