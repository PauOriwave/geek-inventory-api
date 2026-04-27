import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import { normalizeText, parseEuroPrice, similarityScore } from "../utils";
import { ScraperSourceResult } from "../scraper.types";

type Candidate = {
  title: string;
  price: number | null;
  url: string;
};

type CategoryTarget = {
  url: string;
  allowedSlugs: string[];
};

const BASE_URL = "https://www.chollogames.es";
const REQUEST_TIMEOUT_MS = 15000;

const PLATFORM_CATEGORY_TARGETS: Record<string, CategoryTarget> = {
  gamecube: {
    url: `${BASE_URL}/18-gamecube`,
    allowedSlugs: ["gamecube", "gamecube-importacion"]
  },
  "nintendo gamecube": {
    url: `${BASE_URL}/18-gamecube`,
    allowedSlugs: ["gamecube", "gamecube-importacion"]
  },

  "playstation 2": {
    url: `${BASE_URL}/56-playstation-2`,
    allowedSlugs: ["playstation-2", "playstation-2-importacion"]
  },
  ps2: {
    url: `${BASE_URL}/56-playstation-2`,
    allowedSlugs: ["playstation-2", "playstation-2-importacion"]
  },

  "playstation 3": {
    url: `${BASE_URL}/58-playstation-3`,
    allowedSlugs: ["playstation-3", "playstation-3-importacion"]
  },
  ps3: {
    url: `${BASE_URL}/58-playstation-3`,
    allowedSlugs: ["playstation-3", "playstation-3-importacion"]
  },

  "playstation 4": {
    url: `${BASE_URL}/60-playstation-4`,
    allowedSlugs: ["playstation-4"]
  },
  ps4: {
    url: `${BASE_URL}/60-playstation-4`,
    allowedSlugs: ["playstation-4"]
  },

  "playstation 5": {
    url: `${BASE_URL}/59-playstation-5`,
    allowedSlugs: ["playstation-5"]
  },
  ps5: {
    url: `${BASE_URL}/59-playstation-5`,
    allowedSlugs: ["playstation-5"]
  },

  playstation: {
    url: `${BASE_URL}/25-playstation`,
    allowedSlugs: ["playstation"]
  },
  ps1: {
    url: `${BASE_URL}/25-playstation`,
    allowedSlugs: ["playstation"]
  },

  psp: {
    url: `${BASE_URL}/61-psp`,
    allowedSlugs: ["psp"]
  },

  psvita: {
    url: `${BASE_URL}/62-psvita`,
    allowedSlugs: ["psvita"]
  },
  "ps vita": {
    url: `${BASE_URL}/62-psvita`,
    allowedSlugs: ["psvita"]
  },

  xbox: {
    url: `${BASE_URL}/63-xbox`,
    allowedSlugs: ["xbox"]
  },
  "xbox 360": {
    url: `${BASE_URL}/64-xbox-360`,
    allowedSlugs: ["xbox-360"]
  },
  "xbox one": {
    url: `${BASE_URL}/65-xbox-one`,
    allowedSlugs: ["xbox-one"]
  },
  "xbox series x": {
    url: `${BASE_URL}/66-xbox-series-x`,
    allowedSlugs: ["xbox-series-x"]
  },

  "nintendo wii": {
    url: `${BASE_URL}/50-nintendo-wii`,
    allowedSlugs: ["nintendo-wii", "nintendo-wii-importacion"]
  },
  wii: {
    url: `${BASE_URL}/50-nintendo-wii`,
    allowedSlugs: ["nintendo-wii", "nintendo-wii-importacion"]
  },

  "wii u": {
    url: `${BASE_URL}/51-wii-u`,
    allowedSlugs: ["wii-u"]
  },
  "wii-u": {
    url: `${BASE_URL}/51-wii-u`,
    allowedSlugs: ["wii-u"]
  },

  "nintendo switch": {
    url: `${BASE_URL}/43-nintendo-switch`,
    allowedSlugs: ["nintendo-switch"]
  },
  switch: {
    url: `${BASE_URL}/43-nintendo-switch`,
    allowedSlugs: ["nintendo-switch"]
  },

  "nintendo ds": {
    url: `${BASE_URL}/47-nintendo-ds`,
    allowedSlugs: ["nintendo-ds"]
  },
  ds: {
    url: `${BASE_URL}/47-nintendo-ds`,
    allowedSlugs: ["nintendo-ds"]
  },

  "nintendo 3ds": {
    url: `${BASE_URL}/46-nintendo-3ds`,
    allowedSlugs: ["nintendo-3ds"]
  },
  "3ds": {
    url: `${BASE_URL}/46-nintendo-3ds`,
    allowedSlugs: ["nintendo-3ds"]
  },

  "nintendo 64": {
    url: `${BASE_URL}/48-nintendo-64`,
    allowedSlugs: ["nintendo-64"]
  },
  n64: {
    url: `${BASE_URL}/48-nintendo-64`,
    allowedSlugs: ["nintendo-64"]
  },

  nes: {
    url: `${BASE_URL}/45-nes`,
    allowedSlugs: ["nes"]
  },

  "super nintendo": {
    url: `${BASE_URL}/44-super-nintendo`,
    allowedSlugs: ["super-nintendo"]
  },
  snes: {
    url: `${BASE_URL}/44-super-nintendo`,
    allowedSlugs: ["super-nintendo"]
  },

  gba: {
    url: `${BASE_URL}/42-gameboy-advance`,
    allowedSlugs: ["gameboy-advance"]
  },
  "gameboy advance": {
    url: `${BASE_URL}/42-gameboy-advance`,
    allowedSlugs: ["gameboy-advance"]
  },
  "game boy advance": {
    url: `${BASE_URL}/42-gameboy-advance`,
    allowedSlugs: ["gameboy-advance"]
  },

  "game boy": {
    url: `${BASE_URL}/40-game-boy-bn`,
    allowedSlugs: ["game-boy-bn"]
  },

  "game boy color": {
    url: `${BASE_URL}/41-game-boy-color`,
    allowedSlugs: ["game-boy-color"]
  },

  dreamcast: {
    url: `${BASE_URL}/14-dreamcast`,
    allowedSlugs: ["dreamcast"]
  },

  saturn: {
    url: `${BASE_URL}/52-saturn`,
    allowedSlugs: ["saturn", "saturn-importacion"]
  },
  "sega saturn": {
    url: `${BASE_URL}/52-saturn`,
    allowedSlugs: ["saturn", "saturn-importacion"]
  },

  megadrive: {
    url: `${BASE_URL}/30-megadrive`,
    allowedSlugs: ["megadrive"]
  },
  "mega drive": {
    url: `${BASE_URL}/30-megadrive`,
    allowedSlugs: ["megadrive"]
  },

  "master system": {
    url: `${BASE_URL}/29-master-system`,
    allowedSlugs: ["master-system"]
  },

  "pc engine": {
    url: `${BASE_URL}/24-pc-engine`,
    allowedSlugs: ["pc-engine"]
  },

  "neo geo": {
    url: `${BASE_URL}/32-neo-geo`,
    allowedSlugs: ["neo-geo"]
  },

  "neo geo cd": {
    url: `${BASE_URL}/33-neo-geo-cd`,
    allowedSlugs: ["neo-geo-cd"]
  },

  "32x": {
    url: `${BASE_URL}/8-32x`,
    allowedSlugs: ["32x"]
  },

  "3do": {
    url: `${BASE_URL}/9-3do`,
    allowedSlugs: ["3do"]
  }
};

export async function getCholloGamesPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (item.category !== "videogame") return null;

  const query = cleanQuery(item.name);
  if (!query) return null;

  const target = buildCandidateTarget(item);
  if (!target) return null;

  const urls = [
    ...buildSearchUrls(query),
    ...buildPaginatedUrls(target.url, 3)
  ];

  for (const url of urls) {
    console.log("🎮 CG Crawling:", url);

    const html = await fetchHtml(url);
    if (!html) continue;

    console.log("🎮 CG html length:", html.length, "url:", url);

    const candidates = extractCandidates(html, target.allowedSlugs);

    console.log("🎮 CG candidates:", candidates.length, query);

    if (candidates.length === 0) {
      logHtmlDiagnostics(html, target.allowedSlugs);
      continue;
    }

    const best = pickBestCandidate(item, candidates);

    if (!best) {
      console.log("🎮 CG candidates found but no match:", query);
      continue;
    }

    const detail = await fetchDetail(best.url);
    const detailPrice = detail?.price ?? null;
    const detailTitle = detail?.title ?? null;

    const finalPrice = chooseFinalPrice(best.price, detailPrice);

    if (!finalPrice || finalPrice <= 0) {
      console.log("🎮 CG matched product but no usable price:", {
        title: best.title,
        url: best.url,
        listingPrice: best.price,
        detailPrice
      });
      continue;
    }

    const matchedTitle = detailTitle || best.title;

    console.log("🎮 CG selected:", {
      title: matchedTitle,
      listingPrice: best.price,
      detailPrice,
      finalPrice,
      url: best.url
    });

    return {
      price: Number(finalPrice.toFixed(2)),
      source: "chollo_games",
      confidence: computeConfidence(item, matchedTitle),
      matchedTitle,
      matchedUrl: best.url,
      query
    };
  }

  return null;
}

function buildCandidateTarget(item: Item): CategoryTarget | null {
  const platform = normalizePlatform(item.platform ?? "");
  const target = PLATFORM_CATEGORY_TARGETS[platform];

  if (!target) {
    console.log("🎮 CG skipped: unsupported platform", item.platform);
    return null;
  }

  return target;
}

function buildSearchUrls(query: string): string[] {
  const encoded = encodeURIComponent(query);

  return [
    `${BASE_URL}/buscar?controller=search&search_query=${encoded}`,
    `${BASE_URL}/index.php?controller=search&search_query=${encoded}`,
    `${BASE_URL}/buscar?controller=search&orderby=position&orderway=desc&search_query=${encoded}&submit_search=`
  ];
}

function buildPaginatedUrls(baseUrl: string, pages: number): string[] {
  const urls = [baseUrl];

  for (let page = 2; page <= pages; page++) {
    urls.push(`${baseUrl}?page=${page}`);
  }

  return urls;
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
      console.log("❌ CG fetch failed:", res.status, url);
      return null;
    }

    return await res.text();
  } catch (err) {
    console.log("❌ CG fetch error:", err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractCandidates(html: string, allowedSlugs: string[]): Candidate[] {
  const $ = cheerio.load(html);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  extractPrestashopProductCards($, candidates, seen, allowedSlugs);
  extractProductLinks($, candidates, seen, allowedSlugs);
  extractRawProductUrls(html, candidates, seen, allowedSlugs);

  return candidates;
}

function extractPrestashopProductCards(
  $: cheerio.CheerioAPI,
  candidates: Candidate[],
  seen: Set<string>,
  allowedSlugs: string[]
) {
  const selectors = [
    ".product-miniature",
    ".js-product-miniature",
    "article.product-miniature",
    "[data-id-product]",
    "li.ajax_block_product",
    ".ajax_block_product",
    ".product_block",
    ".product-container"
  ];

  for (const selector of selectors) {
    $(selector).each((_, el) => {
      const root = $(el);

      const title =
        root.find(".product-title a").first().text().trim() ||
        root.find(".product-name").first().text().trim() ||
        root.find(".product-title").first().text().trim() ||
        root.find("h2").first().text().trim() ||
        root.find("h3").first().text().trim() ||
        root.find("a[title]").first().attr("title")?.trim() ||
        root.find("img[alt]").first().attr("alt")?.trim() ||
        root.find("a").first().text().trim() ||
        "";

      const href =
        root.find(".product-title a[href]").first().attr("href") ||
        root.find(".product-name[href]").first().attr("href") ||
        root.find("a[href$='.html']").first().attr("href") ||
        root.find("a[href*='.html']").first().attr("href") ||
        "";

      const priceText =
        root.find(".price").first().text().trim() ||
        root.find(".product-price").first().text().trim() ||
        root.find(".current-price").first().text().trim() ||
        root.find("[itemprop='price']").first().attr("content") ||
        root.find("[itemprop='price']").first().text().trim() ||
        root.text();

      addCandidate({
        title,
        href,
        priceText,
        candidates,
        seen,
        allowedSlugs,
        allowNullPrice: true
      });
    });
  }
}

function extractProductLinks(
  $: cheerio.CheerioAPI,
  candidates: Candidate[],
  seen: Set<string>,
  allowedSlugs: string[]
) {
  $("a[href$='.html'], a[href*='.html']").each((_, el) => {
    const link = $(el);
    const href = link.attr("href") || "";
    const absoluteUrl = absolutize(href);

    if (!looksLikeProductUrl(absoluteUrl, allowedSlugs)) return;

    const root = link.closest("li, article, div, section");

    const imgAlt = link.find("img").first().attr("alt")?.trim() || "";

    const title =
      link.attr("title")?.trim() ||
      imgAlt ||
      normalizeLinkText(link.text()) ||
      root
        .find("h1, h2, h3, .product-title, .product-name, .product-title a, img[alt]")
        .first()
        .attr("alt")
        ?.trim() ||
      root
        .find("h1, h2, h3, .product-title, .product-name, .product-title a")
        .first()
        .text()
        .trim() ||
      titleFromProductUrl(absoluteUrl);

    const priceText =
      root.find(".price").first().text().trim() ||
      root.find(".product-price").first().text().trim() ||
      root.find(".current-price").first().text().trim() ||
      root.find("[itemprop='price']").first().attr("content") ||
      root.find("[itemprop='price']").first().text().trim() ||
      root.text();

    addCandidate({
      title,
      href: absoluteUrl,
      priceText,
      candidates,
      seen,
      allowedSlugs,
      allowNullPrice: true
    });
  });
}

function extractRawProductUrls(
  html: string,
  candidates: Candidate[],
  seen: Set<string>,
  allowedSlugs: string[]
) {
  const regex =
    /https?:\/\/www\.chollogames\.es\/[a-z0-9-]+\/\d+-[a-z0-9-]+.*?\.html/gi;

  const matches = html.match(regex) ?? [];

  for (const rawUrl of matches) {
    const url = decodeHtml(rawUrl);

    if (!looksLikeProductUrl(url, allowedSlugs)) continue;

    addCandidate({
      title: titleFromProductUrl(url),
      href: url,
      priceText: "",
      candidates,
      seen,
      allowedSlugs,
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
  allowedSlugs: string[];
  allowNullPrice?: boolean;
}) {
  const url = absolutize(input.href);

  if (!looksLikeProductUrl(url, input.allowedSlugs)) return;

  const title = cleanTitle(input.title || titleFromProductUrl(url));
  const price = parseLastEuroPrice(input.priceText);

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
    $("h1").first().text().trim() ||
    $("[itemprop='name']").first().text().trim() ||
    $("meta[property='og:title']").attr("content")?.trim() ||
    titleFromProductUrl(url) ||
    null;

  const price =
    parseEuroPrice($("#our_price_display").text().trim()) ??
    parseEuroPrice($("#our_price_display").attr("content")) ??
    parseEuroPrice($("[itemprop='price']").first().attr("content")) ??
    parseEuroPrice($("[itemprop='price']").first().text().trim()) ??
    parseEuroPrice($(".our_price_display").first().text().trim()) ??
    parseEuroPrice($(".current-price .price").first().text().trim()) ??
    parseEuroPrice($(".product-prices .current-price .price").first().text().trim()) ??
    parseEuroPrice($(".product-prices .current-price").first().text().trim()) ??
    parseEuroPrice($(".product-price").first().text().trim()) ??
    parseEuroPrice($(".price").first().text().trim()) ??
    parseEuroPrice($("meta[property='product:price:amount']").attr("content")) ??
    null;

  console.log("🎮 CG detail parsed:", {
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
    "🎮 CG top candidates:",
    scored.slice(0, 8).map((s) => ({
      title: s.candidate.title,
      price: s.candidate.price,
      score: Number(s.score.toFixed(2)),
      url: s.candidate.url
    }))
  );

  const best = scored[0];

  if (!best || best.score < 0.2) return null;

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

  console.log("⚠️ CG detail price rejected:", {
    listingPrice,
    detailPrice,
    difference
  });

  return listingPrice;
}

function parseLastEuroPrice(text: string | null | undefined): number | null {
  const value = String(text || "");
  const matches = [...value.matchAll(/(\d{1,5}(?:[.,]\d{2})?)\s*€/g)];

  if (matches.length > 0) {
    const last = matches[matches.length - 1]?.[1];
    return parseEuroPrice(last ?? null);
  }

  return parseEuroPrice(value);
}

function titleFromProductUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() || "";
    const withoutExt = last.replace(/\.html$/i, "");
    const withoutId = withoutExt.replace(/^\d+-/, "");
    const withoutEan = withoutId.replace(/-\d{8,14}$/i, "");

    return withoutEan
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function normalizeSearchText(value: string): string {
  return normalizeText(value)
    .replace(/\bpal\b/g, "")
    .replace(/\bes\b/g, "")
    .replace(/\bspanish\b/g, "")
    .replace(/\bcastellano\b/g, "")
    .replace(/\bsegunda\b/g, "")
    .replace(/\bmano\b/g, "")
    .replace(/\busado\b/g, "")
    .replace(/\bnuevo\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePlatform(value: string): string {
  const normalized = normalizeText(value);

  if (["ps1", "playstation1", "playstation 1"].includes(normalized)) {
    return "playstation";
  }

  if (["ps2", "playstation2", "playstation 2"].includes(normalized)) {
    return "playstation 2";
  }

  if (["ps3", "playstation3", "playstation 3"].includes(normalized)) {
    return "playstation 3";
  }

  if (["ps4", "playstation4", "playstation 4"].includes(normalized)) {
    return "playstation 4";
  }

  if (["ps5", "playstation5", "playstation 5"].includes(normalized)) {
    return "playstation 5";
  }

  if (["psp"].includes(normalized)) {
    return "psp";
  }

  if (["psvita", "ps vita"].includes(normalized)) {
    return "psvita";
  }

  if (["xbox360", "xbox 360"].includes(normalized)) {
    return "xbox 360";
  }

  if (["xboxone", "xbox one"].includes(normalized)) {
    return "xbox one";
  }

  if (["xboxseriesx", "xbox series x"].includes(normalized)) {
    return "xbox series x";
  }

  if (["wii", "nintendo wii"].includes(normalized)) {
    return "nintendo wii";
  }

  if (["wiiu", "wii u", "wii-u"].includes(normalized)) {
    return "wii u";
  }

  if (["switch", "nintendo switch"].includes(normalized)) {
    return "nintendo switch";
  }

  if (["3ds", "nintendo 3ds"].includes(normalized)) {
    return "nintendo 3ds";
  }

  if (["ds", "nintendo ds"].includes(normalized)) {
    return "nintendo ds";
  }

  if (["n64", "nintendo64", "nintendo 64"].includes(normalized)) {
    return "nintendo 64";
  }

  if (["snes", "super nintendo"].includes(normalized)) {
    return "super nintendo";
  }

  if (["gba", "gameboy advance", "game boy advance"].includes(normalized)) {
    return "gba";
  }

  if (["gamecube", "nintendo gamecube"].includes(normalized)) {
    return "gamecube";
  }

  return normalized;
}

function cleanQuery(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTitle(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/Añadir al carrito/gi, "")
    .replace(/Oferta/gi, "")
    .replace(/Agotado/gi, "")
    .replace(/Leer más/gi, "")
    .replace(/Seleccionar opciones/gi, "")
    .trim();
}

function normalizeLinkText(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/Añadir al carrito/gi, "")
    .replace(/Leer más/gi, "")
    .replace(/Seleccionar opciones/gi, "")
    .trim();
}

function looksLikeProductUrl(href: string, allowedSlugs: string[]): boolean {
  const normalized = href.toLowerCase();

  if (!normalized.startsWith("http")) return false;
  if (!normalized.endsWith(".html")) return false;

  if (normalized.includes("/content/")) return false;
  if (normalized.includes("/module/")) return false;
  if (normalized.includes("/carrito")) return false;
  if (normalized.includes("/login")) return false;
  if (normalized.includes("/consola/")) return false;

  const hasProductPattern =
    /\/[a-z0-9-]+\/\d+-[a-z0-9-]+.*\.html$/i.test(normalized);

  if (!hasProductPattern) return false;

  return allowedSlugs.some((slug) => normalized.includes(slug));
}

function logHtmlDiagnostics(html: string, allowedSlugs: string[]) {
  const productUrlMatches = html.match(
    /https?:\/\/www\.chollogames\.es\/[a-z0-9-]+\/\d+-[a-z0-9-]+.*?\.html/gi
  );

  const allowedProductUrlMatches = (productUrlMatches ?? []).filter((url) =>
    allowedSlugs.some((slug) => url.toLowerCase().includes(slug))
  );

  console.log("🎮 CG diagnostics:", {
    containsPrestashopProductMiniature: html.includes("product-miniature"),
    containsProductName: html.includes("product-name"),
    containsAjaxBlockProduct: html.includes("ajax_block_product"),
    containsPriceClass: html.includes("price"),
    containsHtmlProductUrlPattern: /\/[a-z0-9-]+\/\d+-[a-z0-9-]+.*\.html/i.test(
      html
    ),
    allowedSlugs,
    sampleProductUrls: productUrlMatches?.slice(0, 5) ?? [],
    sampleAllowedProductUrls: allowedProductUrlMatches.slice(0, 5)
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