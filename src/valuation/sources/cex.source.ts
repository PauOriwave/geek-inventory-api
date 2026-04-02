import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import {
  normalizeText,
  parseEuroPrice,
  similarityScore
} from "../utils";

type CexCandidate = {
  title: string;
  price: number;
  href?: string;
};

const CEX_BASE_URL = "https://es.webuy.com";

export async function getCexPrice(item: Item) {
  const query = buildSearchQuery(item);
  if (!query) return null;

  const searchUrl = `${CEX_BASE_URL}/search?stext=${encodeURIComponent(query)}`;

  console.log("🔍 Searching CEX:", searchUrl);

  const res = await fetch(searchUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"
    }
  });

  if (!res.ok) {
    throw new Error(`CeX search failed (${res.status})`);
  }

  const html = await res.text();
  console.log("📄 HTML length:", html.length);

  const candidates = extractCandidates(html);
  console.log("📦 Candidates:", candidates.length);

  if (candidates.length === 0) {
    return null;
  }

  const best = pickBestCandidate(item, candidates);

  if (!best) {
    return null;
  }

  const confidence = computeConfidence(item, best.title);

  return {
    price: best.price,
    source: "cex",
    confidence
  };
}

function buildSearchQuery(item: Item): string {
  const parts = [item.name, item.platform ?? "", item.region ?? ""]
    .map((v) => String(v || "").trim())
    .filter(Boolean);

  return parts.join(" ").trim();
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
  const wanted = [item.name, item.platform ?? "", item.region ?? ""]
    .filter(Boolean)
    .join(" ");

  const scored = candidates.map((candidate) => {
    let score = similarityScore(wanted, candidate.title);

    if (item.platform) {
      const platformNorm = normalizeText(item.platform);
      if (normalizeText(candidate.title).includes(platformNorm)) {
        score += 0.1;
      }
    }

    if (item.region) {
      const regionNorm = normalizeText(item.region);
      if (normalizeText(candidate.title).includes(regionNorm)) {
        score += 0.05;
      }
    }

    return { candidate, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return null;

  if (best.score < 0.25) {
    return null;
  }

  return best.candidate;
}

function computeConfidence(item: Item, matchedTitle: string): number {
  const wanted = [item.name, item.platform ?? "", item.region ?? ""]
    .filter(Boolean)
    .join(" ");

  const base = similarityScore(wanted, matchedTitle);

  let confidence = 0.45 + base * 0.45;

  if (item.platform) {
    const platformNorm = normalizeText(item.platform);
    if (normalizeText(matchedTitle).includes(platformNorm)) {
      confidence += 0.05;
    }
  }

  if (item.region) {
    const regionNorm = normalizeText(item.region);
    if (normalizeText(matchedTitle).includes(regionNorm)) {
      confidence += 0.03;
    }
  }

  return Math.max(0.1, Math.min(0.95, Number(confidence.toFixed(2))));
}