import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import { normalizeText, similarityScore, parseEuroPrice } from "../utils";
import { ScraperSourceResult } from "../scraper.types";

const BASE_URL = "https://www.lacentral.com";

export async function getLaCentralPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (item.category !== "book") return null;

  const slug = buildSlug(item.name);

  const candidateUrls = [
    `${BASE_URL}/${slug}`,
    `${BASE_URL}/${slug}/`,
  ];

  for (const url of candidateUrls) {
    console.log("📚 LC trying:", url);

    const html = await fetchHtml(url);
    if (!html) continue;

    const detail = parseDetail(html);

    if (!detail?.price) continue;

    const confidence = computeConfidence(item.name, detail.title);

    console.log("📚 LC selected:", {
      title: detail.title,
      price: detail.price,
      url
    });

    return {
      price: Number(detail.price.toFixed(2)),
      source: "la_central",
      confidence,
      matchedTitle: detail.title,
      matchedUrl: url,
      query: item.name
    };
  }

  return null;
}

/* ============================= */

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!res.ok) return null;

    return await res.text();
  } catch {
    return null;
  }
}

/* ============================= */

function parseDetail(html: string) {
  const $ = cheerio.load(html);

  const title =
    $("h1").first().text().trim() ||
    "";

  const priceText =
    $("#gastos_precio").text().trim() ||
    $(".price").text().trim();

  const price = parseEuroPrice(priceText);

  if (!price || price <= 0) return null;

  return {
    title,
    price
  };
}

/* ============================= */

function buildSlug(name: string): string {
  return normalizeText(name)
    .replace(/\s+/g, "-")
    .toLowerCase();
}

/* ============================= */

function computeConfidence(wanted: string, matched: string): number {
  const a = normalizeText(wanted);
  const b = normalizeText(matched);

  let confidence = 0.5 + similarityScore(a, b) * 0.4;

  if (b.includes(a)) confidence += 0.05;

  return Math.min(0.92, Number(confidence.toFixed(2)));
}