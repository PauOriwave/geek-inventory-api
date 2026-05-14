import { Item } from "@prisma/client";
import * as cheerio from "cheerio";

import { ScraperSourceResult } from "../scraper.types";
import { normalizeText, similarityScore } from "../utils";

type PriceChartingCandidate = {
  title: string;
  consoleName: string | null;
  loosePrice: number | null;
  completePrice: number | null;
  newPrice: number | null;
  gradedPrice: number | null;
  url: string;
  score: number;
};

const BASE_URL = "https://www.pricecharting.com";
const REQUEST_TIMEOUT_MS = 12000;

export async function getPriceChartingComicPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (item.category !== "comic") return null;

  console.log("📈 PriceCharting Comic called:", {
    itemId: item.id,
    name: item.name,
    category: item.category,
    platform: item.platform,
    region: item.region,
    condition: item.condition,
    notes: item.notes
  });

  const queries = buildQueries(item.name);
  const allCandidates: PriceChartingCandidate[] = [];

  for (const query of queries) {
    const searchUrl = buildSearchUrl(query);

    console.log("📈 PriceCharting Comic searching:", searchUrl);

    const html = await fetchHtml(searchUrl);
    if (!html) continue;

    const extracted = extractCandidates(html, item);

    allCandidates.push(...extracted);

    if (allCandidates.length > 0) break;
  }

  const deduped = dedupeCandidates(allCandidates);

  console.log(
    "📈 PriceCharting Comic candidates:",
    deduped.slice(0, 10).map((candidate) => ({
      title: candidate.title,
      consoleName: candidate.consoleName,
      loosePrice: candidate.loosePrice,
      completePrice: candidate.completePrice,
      newPrice: candidate.newPrice,
      gradedPrice: candidate.gradedPrice,
      score: Number(candidate.score.toFixed(2)),
      url: candidate.url
    }))
  );

  const best = deduped[0];

  if (!best || best.score < 0.7) {
    console.log("📈 PriceCharting Comic no match:", item.name);
    return null;
  }

  const detail = await fetchProductDetail(best.url);

  const selectedPrice =
    detail?.prices.complete ??
    detail?.prices.loose ??
    best.completePrice ??
    best.loosePrice ??
    best.newPrice;

  if (!selectedPrice || selectedPrice <= 0) {
    return null;
  }

  console.log("📈 PriceCharting Comic detail parsed:", {
    url: best.url,
    title: detail?.title,
    consoleName: detail?.consoleName,
    prices: detail?.prices,
    recentSales: detail?.recentSales?.slice(0, 5)
  });

  return {
    price: Number(selectedPrice.toFixed(2)),
    currency: "USD",
    source: "pricecharting_comic",
    confidence: computeConfidence(best.score),
    matchedTitle: detail?.title ?? best.title,
    matchedUrl: best.url,
    query: item.name,
    metadata: {
      provider: "pricecharting",
      category: "comic",
      url: best.url,
      consoleName: detail?.consoleName ?? best.consoleName,
      prices: detail?.prices ?? {
        loose: best.loosePrice,
        complete: best.completePrice,
        new: best.newPrice,
        graded: best.gradedPrice
      },
      recentSales: detail?.recentSales ?? []
    }
  };
}

function buildQueries(name: string): string[] {
  const clean = cleanQuery(name);

  const noHash = clean.replace(/#/g, " ");
  const noIssue = noHash.replace(/\b\d+\b/g, " ").replace(/\s+/g, " ").trim();

  return [...new Set([clean, noHash, noIssue])]
    .map((query) => query.trim())
    .filter(Boolean);
}

function buildSearchUrl(query: string): string {
  return `${BASE_URL}/search-products?q=${encodeURIComponent(
    query
  )}&type=prices`;
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
        "Accept-Language": "en-US,en;q=0.9",
        Referer: BASE_URL
      }
    });

    if (!res.ok) {
      console.log("❌ PriceCharting Comic fetch failed:", {
        status: res.status,
        url
      });

      return null;
    }

    return await res.text();
  } catch (error) {
    console.log("❌ PriceCharting Comic fetch error:", {
      url,
      error
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractCandidates(
  html: string,
  item: Item
): PriceChartingCandidate[] {
  const $ = cheerio.load(html);

  const candidates: PriceChartingCandidate[] = [];

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href") || "";

    if (!href) return;

    const url = absolutize(href);

    if (!isComicProductUrl(url)) return;

    const row =
      $(element).closest("tr").length > 0
        ? $(element).closest("tr")
        : $(element).closest("div");

    const title =
      cleanTitle($(element).text()) ||
      cleanTitle(row.find("a").first().text());

    if (!title) return;

    const rowText = row.text();

    const prices = extractPrices(rowText);

    const consoleName = extractConsoleName(url);

    const score = scoreCandidate(item, title, consoleName, url);

    if (score < 0.45) return;

    candidates.push({
      title,
      consoleName,
      loosePrice: prices.loose,
      completePrice: prices.complete,
      newPrice: prices.new,
      gradedPrice: prices.graded,
      url,
      score
    });
  });

  return candidates.sort((a, b) => b.score - a.score);
}

function extractPrices(text: string): {
  loose: number | null;
  complete: number | null;
  new: number | null;
  graded: number | null;
} {
  const matches = [...text.matchAll(/\$?\s?(\d+(?:\.\d{1,2})?)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));

  return {
    loose: matches[0] ?? null,
    complete: matches[1] ?? null,
    new: matches[2] ?? null,
    graded: matches[3] ?? null
  };
}

async function fetchProductDetail(url: string): Promise<{
  title: string | null;
  consoleName: string | null;
  prices: {
    loose: number | null;
    complete: number | null;
    new: number | null;
    graded: number | null;
  };
  recentSales: Array<{
    date: string;
    title: string;
    price: number | null;
    source: string;
  }>;
} | null> {
  const html = await fetchHtml(url);
  if (!html) return null;

  const $ = cheerio.load(html);

  const title =
    $("h1").first().text().trim() ||
    $("title").text().trim() ||
    null;

  const consoleName =
    $(".console-name").first().text().trim() ||
    extractConsoleName(url);

  const prices = {
    loose: extractPriceFromLabel($, "Loose"),
    complete: extractPriceFromLabel($, "Complete"),
    new: extractPriceFromLabel($, "New"),
    graded: extractPriceFromLabel($, "Graded")
  };

  const recentSales: Array<{
    date: string;
    title: string;
    price: number | null;
    source: string;
  }> = [];

  $("table tr").each((_, row) => {
    const cells = $(row).find("td");

    if (cells.length < 3) return;

    const date = cleanTitle($(cells[0]).text());
    const title = cleanTitle($(cells[1]).text());
    const price = parseDollarPrice($(cells[2]).text());

    if (!date || !title) return;

    recentSales.push({
      date,
      title,
      price,
      source: "ebay"
    });
  });

  return {
    title,
    consoleName,
    prices,
    recentSales
  };
}

function extractPriceFromLabel(
  $: cheerio.CheerioAPI,
  label: string
): number | null {
  const text = $(`*:contains("${label}")`).first().parent().text();

  return parseDollarPrice(text);
}

function scoreCandidate(
  item: Item,
  title: string,
  consoleName: string | null,
  url: string
): number {
  const wanted = normalizeSearchText(item.name);
  const candidate = normalizeSearchText(
    `${title} ${consoleName ?? ""}`
  );

  let score = similarityScore(wanted, candidate);

  if (candidate.includes(wanted)) {
    score += 0.9;
  }

  const wantedTokens = wanted.split(" ").filter(Boolean);

  const matchedTokens = wantedTokens.filter((token) =>
    candidate.includes(token)
  );

  score += (matchedTokens.length / Math.max(1, wantedTokens.length)) * 1.2;

  const issueMatch = item.name.match(/#?\s?(\d{1,5})/);

  if (issueMatch?.[1]) {
    if (candidate.includes(issueMatch[1])) {
      score += 1.2;
    } else {
      score -= 0.8;
    }
  }

  if (isComicContext(title, url, consoleName)) {
    score += 0.35;
  } else {
    score -= 0.35;
  }

  if (isClearlyNonComic(title, url, consoleName)) {
    score -= 1.1;
  }

  const wantedContext = normalizeSearchText(
    `${item.name} ${item.notes ?? ""}`
  );

  const candidateContext = normalizeSearchText(
    `${title} ${url} ${consoleName ?? ""}`
  );

  const variantPenaltyTerms = [
    "facsimile",
    "reprint",
    "foil",
    "variant",
    "newsstand",
    "second print",
    "2nd print",
    "third print",
    "3rd print"
  ];

  for (const term of variantPenaltyTerms) {
    const normalizedTerm = normalizeSearchText(term);

    if (
      candidateContext.includes(normalizedTerm) &&
      !wantedContext.includes(normalizedTerm)
    ) {
      score -= 0.35;
    }
  }

  return Number(score.toFixed(4));
}

function computeConfidence(score: number): number {
  return Math.max(0.45, Math.min(0.96, Number((score / 4.5).toFixed(2))));
}

function dedupeCandidates(
  candidates: PriceChartingCandidate[]
): PriceChartingCandidate[] {
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    const key = normalizeSearchText(candidate.url);

    if (seen.has(key)) return false;

    seen.add(key);

    return true;
  });
}

function isComicContext(
  title: string,
  url: string,
  consoleName: string | null
): boolean {
  const text = normalizeSearchText(
    `${title} ${url} ${consoleName ?? ""}`
  );

  return (
    text.includes("comic") ||
    text.includes("manga") ||
    text.includes("marvel") ||
    text.includes("dc") ||
    text.includes("image comics")
  );
}

function isClearlyNonComic(
  title: string,
  url: string,
  consoleName: string | null
): boolean {
  const text = normalizeSearchText(
    `${title} ${url} ${consoleName ?? ""}`
  );

  const blocked = [
    "dvd",
    "blu ray",
    "strategy guide",
    "video game",
    "nintendo",
    "playstation",
    "xbox",
    "pokemon card",
    "booster",
    "figure",
    "funko"
  ];

  return blocked.some((term) => text.includes(term));
}

function isComicProductUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    if (!parsed.hostname.includes("pricecharting.com")) return false;
    if (!parsed.pathname.includes("/game/")) return false;
    if (parsed.pathname.includes("/offering/")) return false;
    if (parsed.pathname.includes("/search")) return false;

    const path = parsed.pathname.toLowerCase();

    return (
      path.includes("/game/comic-books") ||
      path.includes("/game/manga") ||
      path.includes("/game/comic")
    );
  } catch {
    return false;
  }
}

function extractConsoleName(url: string): string | null {
  try {
    const parsed = new URL(url);

    const parts = parsed.pathname.split("/").filter(Boolean);

    return parts[1]
      ?.replace(/-/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase()) ?? null;
  } catch {
    return null;
  }
}

function parseDollarPrice(text: string | null | undefined): number | null {
  const value = String(text || "");

  const match = value.match(/(\d+(?:\.\d{1,2})?)/);

  if (!match?.[1]) return null;

  const parsed = Number(match[1]);

  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSearchText(value: string): string {
  return normalizeText(value)
    .replace(/[#]/g, " ")
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
    .replace(/\n/g, " ")
    .trim();
}

function absolutize(href: string): string {
  if (href.startsWith("http")) return href;

  if (href.startsWith("/")) {
    return `${BASE_URL}${href}`;
  }

  return `${BASE_URL}/${href}`;
}