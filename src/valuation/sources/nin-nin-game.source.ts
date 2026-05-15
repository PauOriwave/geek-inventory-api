import { Item } from "@prisma/client";
import * as cheerio from "cheerio";

import {
  normalizeText,
  parseEuroPrice,
  similarityScore
} from "../utils";

import { ScraperSourceResult } from "../scraper.types";

type Candidate = {
  title: string;
  price: number | null;
  url: string;
};

const BASE_URL = "https://store.nin-nin-game.com";
const REQUEST_TIMEOUT_MS = 10000;
const DIRECT_PRODUCT_TIMEOUT_MS = 5000;

const SUPPORTED_CATEGORIES = new Set(["merch"]);

export async function getNinNinGamePrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  console.log("🎌 NinNinGame called:", {
    itemId: item.id,
    name: item.name,
    category: item.category,
    platform: item.platform
  });

  if (!SUPPORTED_CATEGORIES.has(item.category)) {
    return null;
  }

  const platform = normalizePlatform(item.platform);

  if (
    !["acrylicstand", "figure", "othermerch"].includes(platform)
  ) {
    return null;
  }

  const queries = buildQueries(item);

  for (const query of queries) {
    const searchUrl = `${BASE_URL}/en/search?controller=search&s=${encodeURIComponent(
      query
    )}`;

    console.log("🎌 NinNinGame searching:", searchUrl);

    const html = await fetchHtml(searchUrl);

    if (!html) continue;

    const candidates = extractCandidates(html);

    console.log(
      "🎌 NinNinGame candidates:",
      candidates.map((c) => ({
        title: c.title,
        price: c.price,
        url: c.url
      }))
    );

    const filtered = filterCandidates(item, candidates);

    console.log(
      "🎌 NinNinGame filtered:",
      filtered.map((c) => ({
        title: c.title,
        price: c.price,
        url: c.url
      }))
    );

    const best = pickBestCandidate(item, filtered);

    if (!best) {
      console.log("🎌 NinNinGame no match:", query);
      continue;
    }

    const result = await buildResult(item, best, query);

    if (result) return result;
  }

  return null;
}

function buildQueries(item: Item): string[] {
  const raw = clean(item.name);

  const queries = new Set<string>();

  queries.add(raw);

  const normalized = normalizeSearchText(raw);

  if (normalized.includes("acrylic")) {
    queries.add(raw.replace(/acrylic/gi, ""));
  }

  if (normalized.includes("stand")) {
    queries.add(raw.replace(/stand/gi, ""));
  }

  if (normalized.includes("acrílico")) {
    queries.add(raw.replace(/acrílico/gi, ""));
  }

  queries.add(`${raw} acrylic stand`);

  const tokens = normalized.split(" ").filter(Boolean);

  if (tokens.length >= 2) {
    queries.add(tokens.slice(0, 2).join(" "));
  }

  return [...queries]
    .map((q) => q.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function extractCandidates(html: string): Candidate[] {
  const $ = cheerio.load(html);

  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_, el) => {
    const link = $(el);

    const href = link.attr("href") || "";

    if (!href.includes("/en/")) return;

    const url = absolutize(href);

    const root = link.closest("article, li, div");

    const title =
      link.attr("title")?.trim() ||
      link.text().trim() ||
      root.find("h2,h3,.product-title").first().text().trim();

    const priceText =
      root.find(".price").first().text().trim() ||
      root.text();

    addCandidate({
      title,
      href: url,
      priceText,
      candidates,
      seen
    });
  });

  return candidates;
}

function addCandidate(input: {
  title: string;
  href: string;
  priceText: string;
  candidates: Candidate[];
  seen: Set<string>;
}) {
  const url = absolutize(input.href);

  const title = clean(input.title);

  if (!title || !url) return;

  const key = `${normalizeText(title)}|${url}`;

  if (input.seen.has(key)) return;

  input.seen.add(key);

  input.candidates.push({
    title,
    price: parsePrice(input.priceText),
    url
  });
}

function filterCandidates(
  item: Item,
  candidates: Candidate[]
): Candidate[] {
  const wanted = normalizeSearchText(item.name);

  const tokens = getImportantTokens(wanted);

  return candidates.filter((candidate) => {
    const title = normalizeSearchText(candidate.title);

    return tokens.every((token) => title.includes(token));
  });
}

function pickBestCandidate(
  item: Item,
  candidates: Candidate[]
): Candidate | null {
  if (candidates.length === 0) {
    return null;
  }

  const wanted = normalizeSearchText(item.name);

  const scored = candidates.map((candidate) => {
    const score = similarityScore(
      wanted,
      normalizeSearchText(candidate.title)
    );

    return {
      candidate,
      score
    };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log(
    "🎌 NinNinGame top:",
    scored.slice(0, 5).map((s) => ({
      title: s.candidate.title,
      score: Number(s.score.toFixed(2)),
      price: s.candidate.price
    }))
  );

  const best = scored[0];

  if (!best || best.score < 0.45) {
    return null;
  }

  return best.candidate;
}

async function buildResult(
  item: Item,
  candidate: Candidate,
  query: string
): Promise<ScraperSourceResult | null> {
  const detail = await fetchDetail(candidate.url);

  const finalPrice =
    detail?.price ||
    candidate.price;

  if (!finalPrice || finalPrice <= 0) {
    return null;
  }

  const matchedTitle =
    detail?.title ||
    candidate.title;

  const confidence = computeConfidence(
    item,
    matchedTitle
  );

  console.log("🎌 NinNinGame selected:", {
    title: matchedTitle,
    finalPrice,
    confidence,
    url: candidate.url
  });

  return {
    price: Number(finalPrice.toFixed(2)),
    currency: "EUR",
    source: "nin_nin_game",
    confidence,
    matchedTitle,
    matchedUrl: candidate.url,
    query,
    metadata: {
      provider: "nin-nin-game",
      url: candidate.url,
      category: item.category,
      platform: item.platform
    }
  };
}

async function fetchDetail(
  url: string
): Promise<{ title: string | null; price: number | null } | null> {
  const html = await fetchHtml(
    url,
    DIRECT_PRODUCT_TIMEOUT_MS
  );

  if (!html) return null;

  const $ = cheerio.load(html);

  const title =
    $("h1").first().text().trim() ||
    $("title").text().trim();

  const price =
    parsePrice(
      $(".price").first().text().trim()
    ) ||
    extractPriceFromJson(html);

  return {
    title,
    price
  };
}

async function fetchHtml(
  url: string,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<string | null> {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
      }
    });

    if (!res.ok) {
      console.log(
        "❌ NinNinGame fetch failed:",
        res.status,
        url
      );

      return null;
    }

    return await res.text();
  } catch (error) {
    console.log("❌ NinNinGame fetch error:", {
      url,
      error
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parsePrice(
  value: string | null | undefined
): number | null {
  const text = String(value || "");

  const euro =
    text.match(/€\s?(\d+(?:[.,]\d+)?)/i) ||
    text.match(/(\d+(?:[.,]\d+)?)\s?€/i);

  if (euro?.[1]) {
    return parseEuroPrice(euro[1]);
  }

  return null;
}

function extractPriceFromJson(
  html: string
): number | null {
  const matches = [
    ...html.matchAll(
      /"price"\s*:\s*"?(\\d+(?:\\.\\d+)?)"?/g
    )
  ];

  const prices = matches
    .map((m) => Number(m[1]))
    .filter((p) => Number.isFinite(p));

  return prices[0] ?? null;
}

function normalizePlatform(
  value: string | null
): string {
  const normalized = normalizeText(value || "");

  if (normalized.includes("acrylic")) {
    return "acrylicstand";
  }

  if (normalized.includes("figure")) {
    return "figure";
  }

  return "othermerch";
}

function normalizeSearchText(
  value: string
): string {
  return normalizeText(value)
    .replace(/\s+/g, " ")
    .trim();
}

function getImportantTokens(
  value: string
): string[] {
  return value
    .split(" ")
    .filter(Boolean)
    .filter((t) => t.length > 2)
    .filter(
      (t) =>
        ![
          "stand",
          "acrylic",
          "acrilico",
          "figure"
        ].includes(t)
    );
}

function clean(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function absolutize(href: string): string {
  if (href.startsWith("http")) {
    return href;
  }

  return `${BASE_URL}${href}`;
}

function computeConfidence(
  item: Item,
  matchedTitle: string
): number {
  const wanted = normalizeSearchText(
    item.name
  );

  const matched = normalizeSearchText(
    matchedTitle
  );

  let confidence =
    0.45 +
    similarityScore(wanted, matched) * 0.45;

  if (matched.includes(wanted)) {
    confidence += 0.08;
  }

  return Math.max(
    0.3,
    Math.min(
      0.92,
      Number(confidence.toFixed(2))
    )
  );
}