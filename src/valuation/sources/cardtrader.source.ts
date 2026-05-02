import { Item } from "@prisma/client";
import * as cheerio from "cheerio";
import { ScraperSourceResult } from "../scraper.types";
import { normalizeText, parseEuroPrice, similarityScore } from "../utils";

type ParsedTcgQuery = {
  cleanName: string;
  setCode: string | null;
  cardNumber: string | null;
};

type TcgDexCard = {
  id?: string;
  name?: string;
  localId?: string;
  rarity?: string;
  image?: string;
  set?: {
    id?: string;
    name?: string;
    cardCount?: {
      official?: number;
      total?: number;
    };
  };
};

type CardTraderCandidate = {
  title: string;
  url: string;
  cardNumber: string | null;
  setName: string | null;
  score: number;
};

type CardTraderDetail = {
  title: string;
  url: string;
  price: number | null;
  priceBasis: string;
  currency: "EUR" | "USD" | "GBP" | null;
  rawPriceText: string | null;
};

const CARDTRADER_BASE_URL = "https://www.cardtrader.com";
const TCGDEX_BASE_URL = "https://api.tcgdex.net/v2/en";
const REQUEST_TIMEOUT_MS = 15000;

const KNOWN_SET_ALIASES: Record<string, { name: string; total?: string }> = {
  POR: {
    name: "Perfect Order",
    total: "088"
  }
};

const RARITY_SLUGS = [
  "full-art",
  "ultra-rare",
  "special-illustration-rare",
  "illustration-rare",
  "secret-rare",
  "double-rare",
  "triple-rare",
  "rare",
  "holo-rare",
  "super-rare",
  "common",
  "uncommon"
];

export async function getCardTraderPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  if (item.category !== "tcg") return null;

  const query = String(item.name || "").trim();
  if (!query) return null;

  const parsed = parseTcgQuery(item);

  console.log("🟧 CT called:", {
    itemId: item.id,
    name: item.name,
    parsed
  });

  const tcgdexCards = await resolveFromTcgDex(parsed);
  const candidates = buildCardTraderCandidates(parsed, tcgdexCards);

  console.log(
    "🟧 CT candidates:",
    candidates.slice(0, 10).map((candidate) => ({
      title: candidate.title,
      cardNumber: candidate.cardNumber,
      setName: candidate.setName,
      score: Number(candidate.score.toFixed(2)),
      url: candidate.url
    }))
  );

  for (const candidate of candidates) {
    console.log("🟧 CT Detail:", candidate.url);

    const html = await fetchHtml(candidate.url);
    if (!html) continue;

    const detail = parseCardTraderDetail(html, candidate.url);

    if (!detail) continue;

    const confidence = computeConfidence(parsed, candidate, detail);

    console.log("🟧 CT parsed:", {
      title: detail.title,
      price: detail.price,
      priceBasis: detail.priceBasis,
      currency: detail.currency,
      confidence,
      url: detail.url
    });

    if (!detail.price || detail.price <= 0) {
      return {
        price: 0,
        source: "cardtrader",
        confidence,
        matchedTitle: detail.title,
        matchedUrl: detail.url,
        query,
        metadata: {
          provider: "cardtrader",
          hasPrice: false,
          priceBasis: detail.priceBasis,
          currency: detail.currency,
          rawPriceText: detail.rawPriceText,
          parsed,
          candidate,
          tcgdexCandidates: tcgdexCards.slice(0, 10)
        }
      };
    }

    return {
      price: Number(detail.price.toFixed(2)),
      source: "cardtrader",
      confidence,
      matchedTitle: detail.title,
      matchedUrl: detail.url,
      query,
      metadata: {
        provider: "cardtrader",
        hasPrice: true,
        priceBasis: detail.priceBasis,
        currency: detail.currency,
        rawPriceText: detail.rawPriceText,
        parsed,
        candidate,
        tcgdexCandidates: tcgdexCards.slice(0, 10)
      }
    };
  }

  console.log("🟧 CT no usable page found:", parsed);

  return null;
}

async function resolveFromTcgDex(
  parsed: ParsedTcgQuery
): Promise<TcgDexCard[]> {
  const url = `${TCGDEX_BASE_URL}/cards?name=${encodeURIComponent(
    parsed.cleanName
  )}`;

  console.log("🟧 CT resolving identity from TCGdex:", url);

  const cards = await fetchJson<TcgDexCard[]>(url);

  if (!cards || cards.length === 0) return [];

  return cards
    .map((card) => ({
      ...card,
      score: scoreTcgDexCard(parsed, card)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}

function buildCardTraderCandidates(
  parsed: ParsedTcgQuery,
  tcgdexCards: TcgDexCard[]
): CardTraderCandidate[] {
  const candidates: CardTraderCandidate[] = [];
  const seen = new Set<string>();

  const knownSet = parsed.setCode ? KNOWN_SET_ALIASES[parsed.setCode] : null;

  const baseCards =
    tcgdexCards.length > 0
      ? tcgdexCards
      : [
          {
            name: parsed.cleanName,
            localId: parsed.cardNumber ?? undefined,
            set: knownSet
              ? {
                  name: knownSet.name,
                  cardCount: {
                    official: knownSet.total
                      ? Number(knownSet.total)
                      : undefined
                  }
                }
              : undefined
          }
        ];

  for (const card of baseCards) {
    const name = card.name || parsed.cleanName;
    const localId = normalizeCardNumber(card.localId || parsed.cardNumber || "");
    const setName = card.set?.name || knownSet?.name || null;

    if (!name || !localId || !setName) continue;

    const total =
      padCardTotal(card.set?.cardCount?.official) ||
      padCardTotal(card.set?.cardCount?.total) ||
      knownSet?.total ||
      null;

    const setSlug = slugify(setName);
    const nameSlug = slugify(name);
    const raritySlugs = buildRaritySlugs(card.rarity);

    for (const raritySlug of raritySlugs) {
      const numberPart = total ? `${localId}-${total}` : localId;

      const url = `${CARDTRADER_BASE_URL}/en/cards/${nameSlug}-${raritySlug}-${numberPart}-${setSlug}`;

      addCandidate(candidates, seen, {
        title: `${name} (${localId}${total ? `/${total}` : ""}) - ${setName}`,
        url,
        cardNumber: localId,
        setName,
        score: scoreCandidate(parsed, {
          title: name,
          cardNumber: localId,
          setName
        })
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

function buildRaritySlugs(rarity?: string): string[] {
  const slugs = new Set<string>();

  const normalized = normalizeText(rarity || "");

  if (normalized.includes("special") && normalized.includes("illustration")) {
    slugs.add("special-illustration-rare");
  }

  if (normalized.includes("illustration")) {
    slugs.add("illustration-rare");
  }

  if (normalized.includes("ultra")) {
    slugs.add("ultra-rare");
  }

  if (normalized.includes("double")) {
    slugs.add("double-rare");
  }

  if (normalized.includes("rare")) {
    slugs.add("rare");
  }

  for (const slug of RARITY_SLUGS) {
    slugs.add(slug);
  }

  return [...slugs];
}

function parseCardTraderDetail(
  html: string,
  url: string
): CardTraderDetail | null {
  const $ = cheerio.load(html);

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  const title =
    cleanTitle($("h1").first().text()) ||
    cleanTitle($("h2").first().text()) ||
    cleanTitle($("meta[property='og:title']").attr("content") || "") ||
    titleFromUrl(url);

  if (!title) return null;

  const price =
    extractPriceAfterLabel(bodyText, [
      "CT Min Price",
      "CT Market Price",
      "Best Deal",
      "US Market Price"
    ]) ?? extractFirstUsableCurrencyPrice(bodyText);

  const rawPriceText = extractRawPriceText(bodyText);

  return {
    title,
    url,
    price: price?.price ?? null,
    priceBasis: price?.basis ?? "none",
    currency: price?.currency ?? null,
    rawPriceText
  };
}

function extractPriceAfterLabel(
  text: string,
  labels: string[]
): { price: number; basis: string; currency: "EUR" | "USD" | "GBP" } | null {
  for (const label of labels) {
    const escaped = escapeRegExp(label);

    const patterns = [
      new RegExp(
        `${escaped}\\s*[:\\-]?\\s*([€$£])\\s*(\\d{1,6}(?:[.,]\\d{1,2})?)`,
        "i"
      ),
      new RegExp(
        `${escaped}.{0,80}?([€$£])\\s*(\\d{1,6}(?:[.,]\\d{1,2})?)`,
        "i"
      ),
      new RegExp(
        `${escaped}\\s*[:\\-]?\\s*(\\d{1,6}(?:[.,]\\d{1,2})?)\\s*([€$£])`,
        "i"
      ),
      new RegExp(
        `${escaped}.{0,80}?(\\d{1,6}(?:[.,]\\d{1,2})?)\\s*([€$£])`,
        "i"
      )
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match) continue;

      const hasLeadingCurrency = ["€", "$", "£"].includes(match[1] ?? "");

      const currencySymbol = hasLeadingCurrency ? match[1] : match[2];
      const priceText = hasLeadingCurrency ? match[2] : match[1];

      const parsed = parseCardPrice(priceText);
      const currency = parseCurrency(currencySymbol);

      if (parsed && parsed > 0 && currency) {
        return {
          price: parsed,
          basis: label,
          currency
        };
      }
    }
  }

  return null;
}

function extractFirstUsableCurrencyPrice(
  text: string
): { price: number; basis: string; currency: "EUR" | "USD" | "GBP" } | null {
  const matches = [
    ...text.matchAll(/([€$£])\s*(\d{1,6}(?:[.,]\d{1,2})?)/g)
  ];

  for (const match of matches) {
    const currency = parseCurrency(match[1]);
    const price = parseCardPrice(match[2]);

    if (!currency || !price || price <= 0) continue;
    if (price > 100000) continue;

    const index = match.index ?? 0;
    const context = text.slice(Math.max(0, index - 80), index + 120);

    if (isBadPriceContext(context)) continue;

    return {
      price,
      basis: "currency_fallback",
      currency
    };
  }

  return null;
}

function extractRawPriceText(text: string): string | null {
  const labels = ["CT Min Price", "CT Market Price", "Best Deal", "US Market Price"];

  for (const label of labels) {
    const index = text.toLowerCase().indexOf(label.toLowerCase());

    if (index === -1) continue;

    return text.slice(index, index + 120).trim();
  }

  const currencyMatch = text.match(/[€$£]\s*\d{1,6}(?:[.,]\d{1,2})?/);
  return currencyMatch?.[0] ?? null;
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
        "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
        Referer: CARDTRADER_BASE_URL
      }
    });

    if (!res.ok) {
      console.log("❌ CT fetch failed:", {
        status: res.status,
        url
      });

      return null;
    }

    return await res.text();
  } catch (err) {
    console.log("❌ CT fetch error:", {
      url,
      error: err
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json"
      }
    });

    if (!res.ok) {
      console.log("❌ CT identity fetch failed:", {
        status: res.status,
        url
      });

      return null;
    }

    return (await res.json()) as T;
  } catch (err) {
    console.log("❌ CT identity fetch error:", {
      url,
      error: err
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseTcgQuery(item: Item): ParsedTcgQuery {
  const rawName = String(item.name || "").trim();
  const platform = String(item.platform || "").trim();
  const region = String(item.region || "").trim();

  const parenthesisMatch = rawName.match(/\(([^)]+)\)/);
  const content = parenthesisMatch?.[1] ?? "";

  const parts = content
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const setCode =
    platform ||
    parts.find((part) => /^[A-Z0-9]{2,8}$/i.test(part)) ||
    null;

  const cardNumber =
    region ||
    parts.find((part) => /^\d+[a-zA-Z]?\/?\d*[a-zA-Z]?$/.test(part)) ||
    rawName.match(/\b(\d+[a-zA-Z]?\/?\d*[a-zA-Z]?)\b/)?.[1] ||
    null;

  const cleanName = rawName
    .replace(/\([^)]*\)/g, "")
    .replace(/\b\d+[a-zA-Z]?\/?\d*[a-zA-Z]?\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    cleanName: cleanName || rawName,
    setCode: setCode ? normalizeSetCode(setCode) : null,
    cardNumber: cardNumber ? normalizeCardNumber(cardNumber) : null
  };
}

function scoreTcgDexCard(parsed: ParsedTcgQuery, card: TcgDexCard): number {
  let score = 0;

  const wanted = normalizeText(parsed.cleanName);
  const name = normalizeText(card.name || "");

  score += similarityScore(wanted, name);

  if (wanted === name) score += 1;
  if (name.includes(wanted)) score += 0.4;

  if (
    parsed.cardNumber &&
    normalizeCardNumber(card.localId || "") === parsed.cardNumber
  ) {
    score += 0.8;
  }

  return score;
}

function scoreCandidate(
  parsed: ParsedTcgQuery,
  candidate: {
    title: string;
    cardNumber: string | null;
    setName: string | null;
  }
): number {
  let score = 0;

  const wanted = normalizeText(parsed.cleanName);
  const title = normalizeText(candidate.title);

  score += similarityScore(wanted, title);

  if (title === wanted) score += 1;
  if (title.includes(wanted)) score += 0.4;

  if (
    parsed.cardNumber &&
    candidate.cardNumber &&
    normalizeCardNumber(candidate.cardNumber) === parsed.cardNumber
  ) {
    score += 0.8;
  }

  if (parsed.setCode) {
    const knownSet = KNOWN_SET_ALIASES[parsed.setCode];
    if (
      knownSet &&
      candidate.setName &&
      normalizeText(candidate.setName).includes(normalizeText(knownSet.name))
    ) {
      score += 0.5;
    }
  }

  return score;
}

function computeConfidence(
  parsed: ParsedTcgQuery,
  candidate: CardTraderCandidate,
  detail: CardTraderDetail
): number {
  let confidence = 0.45;

  confidence += Math.min(0.25, candidate.score * 0.1);

  if (detail.price && detail.price > 0) confidence += 0.2;

  if (
    parsed.cardNumber &&
    candidate.cardNumber &&
    normalizeCardNumber(candidate.cardNumber) === parsed.cardNumber
  ) {
    confidence += 0.15;
  }

  return Math.max(0.45, Math.min(0.93, Number(confidence.toFixed(2))));
}

function addCandidate(
  candidates: CardTraderCandidate[],
  seen: Set<string>,
  candidate: CardTraderCandidate
) {
  if (!candidate.url) return;

  if (seen.has(candidate.url)) return;
  seen.add(candidate.url);

  candidates.push(candidate);
}

function parseCardPrice(value: string | null | undefined): number | null {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const euro = parseEuroPrice(raw);
  if (euro && euro > 0) return euro;

  const cleaned = raw
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");

  const parsed = Number(cleaned);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseCurrency(value?: string): "EUR" | "USD" | "GBP" | null {
  if (value === "€") return "EUR";
  if (value === "$") return "USD";
  if (value === "£") return "GBP";
  return null;
}

function isBadPriceContext(value: string): boolean {
  const normalized = normalizeText(value);

  const badTokens = [
    "shipping",
    "shipment",
    "condition",
    "password",
    "email",
    "login",
    "sign up",
    "terms",
    "privacy"
  ];

  return badTokens.some((token) => normalized.includes(token));
}

function normalizeSetCode(value: string): string {
  return String(value || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .trim();
}

function normalizeCardNumber(value: string): string {
  return String(value || "")
    .split("/")[0]
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .trim();
}

function padCardTotal(value?: number | string | null): string | null {
  if (value == null) return null;

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  return String(numeric).padStart(3, "0");
}

function slugify(value: string): string {
  return normalizeText(value)
    .replace(/\bpokemon\b/g, "")
    .replace(/\bpokémon\b/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cleanTitle(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() || "";

    return last
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}