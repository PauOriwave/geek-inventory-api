import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import { normalizeText, parseEuroPrice, similarityScore } from "../utils";
import { ScraperSourceResult } from "../scraper.types";

type Candidate = {
  title: string;
  price: number | null;
  url: string;
};

const BASE_URL = "https://www.normacomics.com";
const REQUEST_TIMEOUT_MS = 15000;

const SUPPORTED_CATEGORIES = new Set(["book", "comic"]);

export async function getNormaComicsPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (!SUPPORTED_CATEGORIES.has(item.category)) return null;

  const queries = buildSearchQueries(item.name);

  for (const query of queries) {
    const searchUrl = `${BASE_URL}/catalogsearch/result/?q=${encodeURIComponent(
      query
    )}`;

    console.log("📚 Norma Searching:", searchUrl);

    const html = await fetchHtml(searchUrl);
    if (!html) continue;

    console.log("📚 Norma html length:", html.length, "query:", query);

    const candidates = extractCandidates(html);

    console.log("📚 Norma candidates:", candidates.length, query);

    if (candidates.length === 0) {
      logHtmlDiagnostics(html);
      continue;
    }

    const best = pickBestCandidate(item, candidates);

    if (!best) {
      console.log("📚 Norma candidates found but no match:", query);
      continue;
    }

    const detail = await fetchDetail(best.url);
    const detailPrice = detail?.price ?? null;
    const detailTitle = detail?.title ?? null;

    const finalPrice = chooseFinalPrice(best.price, detailPrice);

    if (!finalPrice || finalPrice <= 0) {
      console.log("📚 Norma matched product but no usable price:", {
        title: best.title,
        url: best.url,
        listingPrice: best.price,
        detailPrice
      });
      continue;
    }

    const matchedTitle = detailTitle || best.title;

    console.log("📚 Norma selected:", {
      title: matchedTitle,
      listingPrice: best.price,
      detailPrice,
      finalPrice,
      url: best.url
    });

    return {
      price: Number(finalPrice.toFixed(2)),
      source: "norma_comics",
      confidence: computeConfidence(item, matchedTitle),
      matchedTitle,
      matchedUrl: best.url,
      query
    };
  }

  return null;
}

function buildSearchQueries(name: string): string[] {
  const clean = cleanQuery(name);
  const parts = clean.split(" ").filter(Boolean);

  return [
    clean,
    parts.slice(0, 6).join(" "),
    parts.slice(0, 5).join(" "),
    parts.slice(0, 4).join(" "),
    parts.slice(0, 3).join(" ")
  ]
    .map((query) => query.trim())
    .filter(Boolean)
    .filter((query, index, arr) => arr.indexOf(query) === index);
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
      console.log("❌ Norma fetch failed:", res.status, url);
      return null;
    }

    return await res.text();
  } catch (err) {
    console.log("❌ Norma fetch error:", err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractCandidates(html: string): Candidate[] {
  const $ = cheerio.load(html);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  extractMagentoCards($, candidates, seen);
  extractProductLinks($, candidates, seen);
  extractJsonLdCandidates($, candidates, seen);
  extractRawProductUrls(html, candidates, seen);

  return candidates;
}

function extractMagentoCards(
  $: cheerio.CheerioAPI,
  candidates: Candidate[],
  seen: Set<string>
) {
  const selectors = [
    "li.product-item",
    ".product-item",
    ".product-item-info",
    ".products-grid .item",
    ".product"
  ];

  for (const selector of selectors) {
    $(selector).each((_, el) => {
      const root = $(el);

      const title =
        root.find(".product-item-link").first().text().trim() ||
        root.find(".product.name a").first().text().trim() ||
        root.find(".product-name a").first().text().trim() ||
        root.find("a.product-item-link").first().attr("title")?.trim() ||
        root.find("a[title]").first().attr("title")?.trim() ||
        root.find("img[alt]").first().attr("alt")?.trim() ||
        root.find("a").first().text().trim() ||
        "";

      const href =
        root.find(".product-item-link[href]").first().attr("href") ||
        root.find(".product.name a[href]").first().attr("href") ||
        root.find(".product-name a[href]").first().attr("href") ||
        root.find("a[href*='.html']").first().attr("href") ||
        root.find("a[href]").first().attr("href") ||
        "";

      const priceText =
        root.find(".special-price .price").first().text().trim() ||
        root.find(".normal-price .price").first().text().trim() ||
        root.find(".price-final_price .price").first().text().trim() ||
        root.find(".price-box .price").first().text().trim() ||
        root.find("[data-price-type='finalPrice']").first().attr("data-price-amount") ||
        root.find(".price").first().text().trim() ||
        root.text();

      addCandidate({
        title,
        href,
        priceText,
        candidates,
        seen,
        allowNullPrice: true
      });
    });
  }
}

function extractProductLinks(
  $: cheerio.CheerioAPI,
  candidates: Candidate[],
  seen: Set<string>
) {
  $("a[href]").each((_, el) => {
    const link = $(el);
    const href = link.attr("href") || "";
    const absoluteUrl = absolutize(href);

    if (!looksLikeProductUrl(absoluteUrl)) return;

    const root = link.closest("li, article, div, section");

    const imgAlt = link.find("img").first().attr("alt")?.trim() || "";

    const title =
      link.attr("title")?.trim() ||
      imgAlt ||
      normalizeLinkText(link.text()) ||
      root
        .find(".product-item-link, .product-name a, h1, h2, h3, img[alt]")
        .first()
        .attr("alt")
        ?.trim() ||
      root
        .find(".product-item-link, .product-name a, h1, h2, h3")
        .first()
        .text()
        .trim() ||
      titleFromProductUrl(absoluteUrl);

    const priceText =
      root.find(".special-price .price").first().text().trim() ||
      root.find(".normal-price .price").first().text().trim() ||
      root.find(".price-final_price .price").first().text().trim() ||
      root.find(".price-box .price").first().text().trim() ||
      root.find("[data-price-type='finalPrice']").first().attr("data-price-amount") ||
      root.find(".price").first().text().trim() ||
      root.text();

    addCandidate({
      title,
      href: absoluteUrl,
      priceText,
      candidates,
      seen,
      allowNullPrice: true
    });
  });
}

function extractJsonLdCandidates(
  $: cheerio.CheerioAPI,
  candidates: Candidate[],
  seen: Set<string>
) {
  $("script[type='application/ld+json']").each((_, el) => {
    const raw = $(el).text();
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      extractJsonLdNode(parsed, candidates, seen);
    } catch {
      return;
    }
  });
}

function extractJsonLdNode(
  node: any,
  candidates: Candidate[],
  seen: Set<string>
) {
  if (!node) return;

  if (Array.isArray(node)) {
    for (const child of node) {
      extractJsonLdNode(child, candidates, seen);
    }
    return;
  }

  if (typeof node !== "object") return;

  if (node["@graph"]) {
    extractJsonLdNode(node["@graph"], candidates, seen);
  }

  const type = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];

  if (!type.includes("Product") && !type.includes("Book")) return;

  const title = typeof node.name === "string" ? node.name : "";
  const href = typeof node.url === "string" ? node.url : "";

  const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;

  const priceText =
    offer?.price ??
    offer?.lowPrice ??
    offer?.highPrice ??
    node.price ??
    "";

  addCandidate({
    title,
    href,
    priceText: String(priceText),
    candidates,
    seen,
    allowNullPrice: true
  });
}

function extractRawProductUrls(
  html: string,
  candidates: Candidate[],
  seen: Set<string>
) {
  const regex =
    /https?:\/\/www\.normacomics\.com\/[a-z0-9\-\/]+\.html/gi;

  const matches = html.match(regex) ?? [];

  for (const rawUrl of matches) {
    const url = decodeHtml(rawUrl);

    if (!looksLikeProductUrl(url)) continue;

    addCandidate({
      title: titleFromProductUrl(url),
      href: url,
      priceText: "",
      candidates,
      seen,
      allowNullPrice: true
    });
  }
}

function addCandidate(input: {
  title: string;
  href: string;
  priceText: string;
  candidates: Candidate[];
  seen: Set<string>;
  allowNullPrice?: boolean;
}) {
  const url = absolutize(input.href);

  if (!looksLikeProductUrl(url)) return;

  const title = cleanTitle(input.title || titleFromProductUrl(url));
  const price = parsePrice(input.priceText);

  if (!title || !url) return;

  if ((price == null || price <= 0) && !input.allowNullPrice) return;

  const key = `${normalizeText(title)}|${price ?? "null"}|${url}`;

  if (input.seen.has(key)) return;
  input.seen.add(key);

  input.candidates.push({
    title,
    price: price != null && price > 0 ? price : null,
    url
  });
}

async function fetchDetail(
  url: string
): Promise<{ title: string | null; price: number | null } | null> {
  const html = await fetchHtml(url);
  if (!html) return null;

  const $ = cheerio.load(html);

  const title =
    $("h1.page-title span").first().text().trim() ||
    $("h1.page-title").first().text().trim() ||
    $("h1").first().text().trim() ||
    $("meta[property='og:title']").attr("content")?.trim() ||
    titleFromProductUrl(url) ||
    null;

  const price =
    parsePrice($("[data-price-type='finalPrice']").first().attr("data-price-amount")) ??
    parsePrice($(".special-price .price").first().text().trim()) ??
    parsePrice($(".normal-price .price").first().text().trim()) ??
    parsePrice($(".price-final_price .price").first().text().trim()) ??
    parsePrice($(".price-box .price").first().text().trim()) ??
    parsePrice($("meta[property='product:price:amount']").attr("content")) ??
    parsePrice($("meta[itemprop='price']").attr("content")) ??
    parsePrice($("[itemprop='price']").first().attr("content")) ??
    parsePrice($("[itemprop='price']").first().text().trim()) ??
    parsePrice($(".price").first().text().trim()) ??
    extractPriceFromMagentoJson(html) ??
    null;

  console.log("📚 Norma detail parsed:", {
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
  const wantedTokens = wanted.split(" ").filter(Boolean);

  const scored = candidates.map((candidate) => {
    const title = normalizeSearchText(candidate.title);
    const url = normalizeSearchText(candidate.url);

    let score = similarityScore(wanted, title);

    if (title.includes(wanted)) score += 0.25;

    if (
      wantedTokens.length > 0 &&
      wantedTokens.every((token) => title.includes(token) || url.includes(token))
    ) {
      score += 0.2;
    }

    if (candidate.price != null && candidate.price > 0) {
      score += 0.05;
    }

    return {
      candidate,
      score
    };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log(
    "📚 Norma top candidates:",
    scored.slice(0, 8).map((s) => ({
      title: s.candidate.title,
      price: s.candidate.price,
      score: Number(s.score.toFixed(2)),
      url: s.candidate.url
    }))
  );

  const best = scored[0];

  if (!best || best.score < 0.45) return null;

  return best.candidate;
}

function chooseFinalPrice(
  listingPrice: number | null,
  detailPrice: number | null
): number | null {
  if (listingPrice == null || listingPrice <= 0) {
    return detailPrice && detailPrice > 0 ? detailPrice : null;
  }

  if (!detailPrice || detailPrice <= 0) return listingPrice;

  const difference = Math.abs(detailPrice - listingPrice);
  const maxAllowedDifference = listingPrice * 0.25;

  if (difference <= maxAllowedDifference) return detailPrice;

  console.log("⚠️ Norma detail price rejected:", {
    listingPrice,
    detailPrice,
    difference
  });

  return listingPrice;
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

function extractPriceFromMagentoJson(html: string): number | null {
  const matches = [
    ...html.matchAll(/"finalPrice"\s*:\s*\{\s*"amount"\s*:\s*(\d+(?:\.\d+)?)/g),
    ...html.matchAll(/"price"\s*:\s*(\d+(?:\.\d+)?)/g)
  ];

  const prices = matches
    .map((match) => Number(match[1]))
    .filter((price) => Number.isFinite(price) && price > 0)
    .sort((a, b) => b - a);

  return prices[0] ?? null;
}

function titleFromProductUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() || "";
    const withoutExt = last.replace(/\.html$/i, "");

    return withoutExt
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
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
    .replace(/Añadir a la Lista de Deseos/gi, "")
    .replace(/Añadir/gi, "")
    .replace(/Comprar/gi, "")
    .replace(/Oferta/gi, "")
    .trim();
}

function normalizeLinkText(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/Añadir a la Lista de Deseos/gi, "")
    .replace(/Añadir/gi, "")
    .replace(/Comprar/gi, "")
    .trim();
}

function looksLikeProductUrl(url: string): boolean {
  const normalized = url.toLowerCase();

  if (!normalized.startsWith("http")) return false;
  if (!normalized.endsWith(".html")) return false;

  if (normalized.includes("/customer/")) return false;
  if (normalized.includes("/checkout/")) return false;
  if (normalized.includes("/wishlist/")) return false;
  if (normalized.includes("/catalogsearch/")) return false;

  return true;
}

function logHtmlDiagnostics(html: string) {
  const productUrlMatches = html.match(
    /https?:\/\/www\.normacomics\.com\/[a-z0-9\-\/]+\.html/gi
  );

  console.log("📚 Norma diagnostics:", {
    containsProductItem: html.includes("product-item"),
    containsProductItemLink: html.includes("product-item-link"),
    containsPriceClass: html.includes("price"),
    containsMagentoPriceBox: html.includes("price-final_price"),
    sampleProductUrls: productUrlMatches?.slice(0, 5) ?? []
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