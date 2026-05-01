import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import { normalizeText, similarityScore } from "../utils";

export type BrickLinkSetMatch = {
  setNumber: string;
  title: string;
  url: string;
  score: number;
};

type BrickLinkCandidate = {
  setNumber: string;
  title: string;
  url: string;
};

const BRICKLINK_BASE_URL = "https://www.bricklink.com";
const REQUEST_TIMEOUT_MS = 15000;

export async function resolveBrickLinkSetNumber(
  item: Item
): Promise<BrickLinkSetMatch | null> {
  if (item.category !== "lego") return null;

  const directSetNumber = extractSetNumber(item.name);

  if (directSetNumber) {
    return {
      setNumber: directSetNumber,
      title: item.name,
      url: `${BRICKLINK_BASE_URL}/v2/catalog/catalogitem.page?S=${directSetNumber}-1`,
      score: 1
    };
  }

  const query = cleanLegoQuery(item.name);
  if (!query) return null;

  const searchUrl = `${BRICKLINK_BASE_URL}/v2/search.page?q=${encodeURIComponent(
    query
  )}`;

  console.log("🧱 BL Searching:", searchUrl);

  const html = await fetchHtml(searchUrl);
  if (!html) return null;

  const candidates = extractCandidates(html);

  console.log("🧱 BL candidates:", candidates.length);

  if (candidates.length === 0) return null;

  const best = pickBestCandidate(item, candidates);

  if (!best) {
    console.log("🧱 BL candidates found but no reliable match:", query);
    return null;
  }

  console.log("🧱 BL selected:", {
    setNumber: best.setNumber,
    title: best.title,
    score: best.score,
    url: best.url
  });

  return best;
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
        Referer: BRICKLINK_BASE_URL
      }
    });

    if (!res.ok) {
      console.log("❌ BL fetch failed:", res.status, url);
      return null;
    }

    return await res.text();
  } catch (err) {
    console.log("❌ BL fetch error:", err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractCandidates(html: string): BrickLinkCandidate[] {
  const $ = cheerio.load(html);
  const candidates: BrickLinkCandidate[] = [];
  const seen = new Set<string>();

  $("a[href*='catalogitem.page']").each((_, el) => {
    const link = $(el);
    const href = link.attr("href") || "";
    const url = absolutize(href);

    const setNumber = extractSetNumberFromBrickLinkUrl(url);
    if (!setNumber) return;

    const title =
      cleanTitle(link.text()) ||
      cleanTitle(link.attr("title") || "") ||
      extractTitleNearLink($, link) ||
      `LEGO ${setNumber}`;

    addCandidate(candidates, seen, {
      setNumber,
      title,
      url
    });
  });

  extractRawCatalogUrls(html).forEach((url) => {
    const setNumber = extractSetNumberFromBrickLinkUrl(url);
    if (!setNumber) return;

    addCandidate(candidates, seen, {
      setNumber,
      title: `LEGO ${setNumber}`,
      url
    });
  });

  return candidates;
}

function pickBestCandidate(
  item: Item,
  candidates: BrickLinkCandidate[]
): BrickLinkSetMatch | null {
  const wanted = normalizeLegoText(item.name);
  const wantedSetNumber = extractSetNumber(item.name);

  const scored = candidates.map((candidate) => {
    const title = normalizeLegoText(candidate.title);
    const url = normalizeLegoText(candidate.url);

    let score = similarityScore(wanted, title);

    if (wantedSetNumber && candidate.setNumber === wantedSetNumber) score += 1;
    if (title.includes(wanted)) score += 0.35;
    if (wanted.includes(title)) score += 0.15;
    if (url.includes(wanted.replace(/\s+/g, "-"))) score += 0.15;

    const wantedTokens = getImportantTokens(wanted);
    const matchedImportantTokens = wantedTokens.filter(
      (token) => title.includes(token) || url.includes(token)
    );

    if (wantedTokens.length > 0) {
      score += (matchedImportantTokens.length / wantedTokens.length) * 0.25;
    }

    return {
      ...candidate,
      score
    };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log(
    "🧱 BL top:",
    scored.slice(0, 8).map((candidate) => ({
      setNumber: candidate.setNumber,
      title: candidate.title,
      score: Number(candidate.score.toFixed(2)),
      url: candidate.url
    }))
  );

  const best = scored[0];

  if (!best) return null;
  if (best.score < 0.35) return null;

  return {
    setNumber: best.setNumber,
    title: best.title,
    url: best.url,
    score: Number(Math.min(1, best.score).toFixed(2))
  };
}

function addCandidate(
  candidates: BrickLinkCandidate[],
  seen: Set<string>,
  candidate: BrickLinkCandidate
) {
  if (!candidate.setNumber || !candidate.url) return;

  const key = `${candidate.setNumber}|${normalizeText(candidate.title)}`;

  if (seen.has(key)) return;
  seen.add(key);

  candidates.push(candidate);
}

function extractRawCatalogUrls(html: string): string[] {
  const decoded = decodeHtml(html)
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/%2F/gi, "/");

  const matches = [
    ...decoded.matchAll(
      /https?:\/\/www\.bricklink\.com\/v2\/catalog\/catalogitem\.page\?S=\d+-\d+/gi
    ),
    ...decoded.matchAll(/\/v2\/catalog\/catalogitem\.page\?S=\d+-\d+/gi)
  ];

  return matches.map((match) => absolutize(match[0]));
}

function extractSetNumberFromBrickLinkUrl(url: string): string | null {
  const match = url.match(/[?&]S=(\d+)-\d+/i);
  return match?.[1] ?? null;
}

function extractSetNumber(value: string): string | null {
  const normalized = String(value || "");

  const patterns = [
    /\blego\s+(\d{4,7})\b/i,
    /\bset\s+(\d{4,7})\b/i,
    /\b(\d{4,7})\b/
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

function extractTitleNearLink(
  $: cheerio.CheerioAPI,
  link: cheerio.Cheerio<any>
): string {
  const root = link.closest("tr, li, div");

  return cleanTitle(
    root.find("a").first().text().trim() ||
      root.find("td").first().text().trim() ||
      root.text().trim()
  );
}

function cleanLegoQuery(value: string): string {
  return String(value || "")
    .replace(/\blego\b/gi, "")
    .replace(/\bset\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLegoText(value: string): string {
  return normalizeText(value)
    .replace(/\blego\b/g, "")
    .replace(/\bset\b/g, "")
    .replace(/\bicons\b/g, "")
    .replace(/\bcreator\b/g, "")
    .replace(/\bexpert\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getImportantTokens(value: string): string[] {
  const stopWords = new Set([
    "lego",
    "set",
    "the",
    "and",
    "de",
    "del",
    "la",
    "el",
    "los",
    "las",
    "una",
    "uno",
    "con",
    "para"
  ]);

  return normalizeLegoText(value)
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length > 2)
    .filter((token) => !stopWords.has(token));
}

function cleanTitle(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/Catalog Item/gi, "")
    .trim();
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
  if (href.startsWith("/")) return `${BRICKLINK_BASE_URL}${href}`;
  return `${BRICKLINK_BASE_URL}/${href}`;
}