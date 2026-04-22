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

type CexCandidate = {
  title: string;
  price: number;
  href?: string;
};

const CEX_BASE_URL = "https://es.webuy.com";

export async function getCexPrice(item: Item) {
  const query = buildSearchText(item);
  if (!query) return null;

  const searchUrl = `${CEX_BASE_URL}/search?stext=${encodeURIComponent(query)}`;

  try {
    const res = await fetch(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html",
        "Accept-Language": "es-ES"
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

    const best = pickBestBySimilarity(item, candidates);

    if (!best) {
      console.log("CEX no match:", query);
      return null;
    }

    const score = similarity(item, best.title);
    const confidence = computeConfidenceFromScore(score);

    return {
      price: best.price,
      source: "cex",
      confidence
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

  $("a").each((_, el) => {
    const root = $(el);

    const title =
      root.attr("title")?.trim() ||
      root.text()?.trim();

    if (!title || title.length < 5) return;

    const priceText = root
      .parent()
      .find("[class*='price']")
      .first()
      .text();

    const price = parseEuroPrice(priceText);
    if (!price || price <= 0) return;

    const key = `${normalizeText(title)}|${price}`;
    if (unique.has(key)) return;
    unique.add(key);

    results.push({
      title,
      price,
      href: absolutize(root.attr("href") || "")
    });
  });

  return results;
}

function absolutize(href: string) {
  if (!href) return undefined;

  if (href.startsWith("http")) return href;
  if (href.startsWith("/")) return `${CEX_BASE_URL}${href}`;

  return `${CEX_BASE_URL}/${href}`;
}

function similarity(item: Item, title: string) {
  const wanted = buildSearchText(item);
  return normalizeText(wanted) === normalizeText(title) ? 1 : 0.5;
}