import { Item } from "@prisma/client";
import * as cheerio from "cheerio";

import { normalizeText, parseEuroPrice, similarityScore } from "../utils";
import { ScraperSourceResult } from "../scraper.types";

type Candidate = {
  title: string;
  price: number | null;
  url: string;
};

type ScoredCandidate = {
  candidate: Candidate;
  score: number;
  reasons: string[];
};

const BASE_URL = "https://www.todocoleccion.net";
const REQUEST_TIMEOUT_MS = 12000;
const DIRECT_DETAIL_TIMEOUT_MS = 6000;
const MIN_ACCEPTED_SCORE = 0.5;

const SUPPORTED_CATEGORIES = new Set(["guide", "magazine", "merch"]);

export async function getTodocoleccionPrice(
  item: Item
): Promise<ScraperSourceResult | null> {
  console.log("🏺 Todocoleccion called:", {
    itemId: item.id,
    name: item.name,
    category: item.category,
    platform: item.platform,
    completeness: item.completeness,
    region: item.region
  });

  const category = normalizeCategory(item.category);

  if (!SUPPORTED_CATEGORIES.has(category)) return null;

  const queries = buildQueries(item);

  for (const query of queries) {
    const urls = buildSearchUrls(query);

    for (const url of urls) {
      console.log("🏺 Todocoleccion searching:", url);

      const html = await fetchHtml(url);
      if (!html) continue;

      const candidates = extractCandidates(html);

      console.log(
        "🏺 Todocoleccion candidates:",
        candidates.slice(0, 20).map((candidate) => ({
          title: candidate.title,
          price: candidate.price,
          url: candidate.url
        }))
      );

      const filtered = filterCandidates(item, candidates);

      console.log(
        "🏺 Todocoleccion filtered:",
        filtered.slice(0, 20).map((candidate) => ({
          title: candidate.title,
          price: candidate.price,
          url: candidate.url
        }))
      );

      const best = pickBestCandidate(item, filtered);

      if (!best) {
        console.log("🏺 Todocoleccion no reliable match:", { query });
        continue;
      }

      console.log("🏺 Todocoleccion best candidate:", {
        title: best.candidate.title,
        score: Number(best.score.toFixed(2)),
        reasons: best.reasons
      });

      const result = await buildResult(item, best.candidate, query);

      if (result) return result;
    }
  }

  return null;
}

function buildSearchUrls(query: string): string[] {
  const encoded = encodeURIComponent(query);

  return [
    `${BASE_URL}/buscador?from=top&bu=${encoded}`,
    `${BASE_URL}/s/${encoded}`
  ];
}

function buildQueries(item: Item): string[] {
  const raw = clean(item.name);
  const normalized = normalizeSearchText(raw);
  const category = normalizeCategory(item.category);
  const platform = normalizePlatform(item.platform);

  const queries = new Set<string>();

  queries.add(raw);

  if (category === "guide") {
    queries.add(`${raw} guia`);
    queries.add(`${raw} guía`);
    queries.add(`${raw} guia oficial`);
    queries.add(`${raw} guía oficial`);
    queries.add(`${raw} strategy guide`);

    if (!normalized.includes("piggyback")) queries.add(`${raw} piggyback`);
    if (!normalized.includes("bradygames")) queries.add(`${raw} bradygames`);
    if (!normalized.includes("future press")) queries.add(`${raw} future press`);
  }

  if (category === "magazine") {
    queries.add(`${raw} revista`);
    queries.add(`${raw} magazine`);

    if (!normalized.includes("hobby consolas")) {
      queries.add(`${raw} hobby consolas`);
    }

    const issue = extractMagazineIssue(raw);

    if (issue) {
      const magazineBase = removeMagazineIssueWords(raw);

      if (magazineBase) {
        queries.add(`${magazineBase} ${issue}`);
        queries.add(`${magazineBase} nº ${issue}`);
        queries.add(`${magazineBase} numero ${issue}`);
        queries.add(`${magazineBase} número ${issue}`);
        queries.add(`${magazineBase} num ${issue}`);
        queries.add(`revista ${magazineBase} nº ${issue}`);
        queries.add(`revista ${magazineBase} numero ${issue}`);
      }
    }
  }

  if (category === "merch") {
    if (platform === "tazo") {
      queries.add(`${raw} tazo`);
      queries.add(`${raw} tazos`);
      queries.add(`${raw} league`);
      queries.add(`${raw} league 2`);
      queries.add(`${raw} matutano`);
      queries.add(`${raw} 151`);
    }

    if (platform === "stack") {
      queries.add(`${raw} stack`);
      queries.add(`${raw} stacks`);
      queries.add(`${raw} staks`);
      queries.add(`${raw} imanes`);
      queries.add(`${raw} coleccion completa`);
      queries.add(`${raw} colección completa`);
      queries.add(`${raw} album completo`);
      queries.add(`${raw} álbum completo`);
      queries.add(`${raw} 260/260`);
    }

    if (platform === "album") {
      queries.add(`${raw} album`);
      queries.add(`${raw} álbum`);
    }

    if (platform === "gachapon") {
      queries.add(`${raw} gachapon`);
      queries.add(`${raw} gashapon`);
    }
  }

  const tokens = normalized.split(" ").filter(Boolean);

  if (tokens.length >= 2) queries.add(tokens.slice(0, 2).join(" "));
  if (tokens.length >= 3) queries.add(tokens.slice(0, 3).join(" "));
  if (tokens.length >= 4) queries.add(tokens.slice(0, 4).join(" "));

  return [...queries]
    .map((query) => query.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((query, index, arr) => arr.indexOf(query) === index)
    .slice(0, 18);
}

function extractCandidates(html: string): Candidate[] {
  const $ = cheerio.load(html);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  $("article, li, .item, .product, .card, div").each((_, el) => {
    const root = $(el);

    const href =
      root.find("a[href*='/lote/']").first().attr("href") ||
      root.find("a[href*='todocoleccion.net']").first().attr("href") ||
      root.find("a[href]").first().attr("href") ||
      "";

    const url = absolutize(href);
    if (!looksLikeProductUrl(url)) return;

    const title =
      root.find("h2, h3, h4").first().text().trim() ||
      root.find("a[title]").first().attr("title")?.trim() ||
      root.find("img[alt]").first().attr("alt")?.trim() ||
      root.find("a[href]").first().text().trim() ||
      titleFromUrl(url);

    const priceText =
      root.find("[class*='price']").first().text().trim() ||
      root.find("[class*='precio']").first().text().trim() ||
      root.text();

    addCandidate({
      title,
      href: url,
      priceText,
      candidates,
      seen
    });
  });

  $("a[href]").each((_, el) => {
    const link = $(el);
    const href = link.attr("href") || "";
    const url = absolutize(href);

    if (!looksLikeProductUrl(url)) return;

    const root = link.closest("article, li, div");

    const title =
      link.attr("title")?.trim() ||
      link.text().trim() ||
      link.find("img").attr("alt")?.trim() ||
      root.find("h2, h3, h4").first().text().trim() ||
      titleFromUrl(url);

    const priceText =
      root.find("[class*='price']").first().text().trim() ||
      root.find("[class*='precio']").first().text().trim() ||
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
  if (!looksLikeProductUrl(url)) return;

  const key = `${normalizeText(title)}|${url}`;
  if (input.seen.has(key)) return;

  input.seen.add(key);

  input.candidates.push({
    title,
    price: parsePrice(input.priceText),
    url
  });
}

function filterCandidates(item: Item, candidates: Candidate[]): Candidate[] {
  const wanted = normalizeSearchText(item.name);
  const category = normalizeCategory(item.category);
  const platform = normalizePlatform(item.platform);
  const tokens = getImportantTokens(wanted, item);

  if (tokens.length === 0) return [];

  return candidates.filter((candidate) => {
    const title = normalizeSearchText(candidate.title);

    if (hasStrongNegativeSignals(item, title)) return false;
    if (!passesCategoryValidation(item, title)) return false;
    if (hasDisallowedMagazineVariant(item, title)) return false;

    if (category === "magazine" && !isMainMagazineCandidate(item, title)) {
      return false;
    }

    if (category === "merch" && platform === "stack") {
      return passesStackCandidateValidation(item, title);
    }

    if (category === "merch" && platform === "tazo") {
      return passesTazoCandidateValidation(item, title);
    }

    if (category !== "magazine" && category !== "merch" && hasEditionConflict(wanted, title)) {
      return false;
    }

    if (!passesIdentityRequirements(item, title)) return false;
    if (hasMagazineIssueConflict(item, title)) return false;

    if (category === "magazine") {
      return passesMagazineTokenValidation(item, title);
    }

    const tokenMatches = tokens.filter((token) => title.includes(token));
    const ratio = tokenMatches.length / tokens.length;

    return ratio >= 0.65;
  });
}

function pickBestCandidate(
  item: Item,
  candidates: Candidate[]
): ScoredCandidate | null {
  if (candidates.length === 0) return null;

  const wanted = normalizeSearchText(item.name);
  const category = normalizeCategory(item.category);
  const platform = normalizePlatform(item.platform);

  const scored: ScoredCandidate[] = candidates.map((candidate) => {
    const title = normalizeSearchText(candidate.title);
    const reasons: string[] = [];

    let score = similarityScore(wanted, title);

    reasons.push(`similarity:${score.toFixed(2)}`);

    if (title.includes(wanted)) {
      score += 0.25;
      reasons.push("full-title-match");
    }

    const identityBoost = getIdentityBoost(item, title);

    if (identityBoost > 0) {
      score += identityBoost;
      reasons.push(`identity-boost:${identityBoost.toFixed(2)}`);
    }

    const categoryBoost = getCategoryBoost(item, title);

    if (categoryBoost > 0) {
      score += categoryBoost;
      reasons.push(`category-boost:${categoryBoost.toFixed(2)}`);
    }

    const magazineBoost = getMagazineIdentityBoost(item, title);

    if (magazineBoost > 0) {
      score += magazineBoost;
      reasons.push(`magazine-boost:${magazineBoost.toFixed(2)}`);
    }

    if (category === "magazine" && isMainMagazineCandidate(item, title)) {
      score += 0.35;
      reasons.push("main-magazine-match");
    }

    if (category === "merch" && platform === "stack") {
      const stackBoost = getStackCollectionBoost(item, title);
      const stackPenalty = getStackCollectionPenalty(item, title);

      if (stackBoost > 0) {
        score += stackBoost;
        reasons.push(`stack-collection-boost:${stackBoost.toFixed(2)}`);
      }

      if (stackPenalty > 0) {
        score -= stackPenalty;
        reasons.push(`stack-collection-penalty:${stackPenalty.toFixed(2)}`);
      }
    }

    if (category === "merch" && platform === "tazo") {
      const tazoBoost = getTazoBoost(item, title);
      const tazoPenalty = getTazoPenalty(item, title);

      if (tazoBoost > 0) {
        score += tazoBoost;
        reasons.push(`tazo-boost:${tazoBoost.toFixed(2)}`);
      }

      if (tazoPenalty > 0) {
        score -= tazoPenalty;
        reasons.push(`tazo-penalty:${tazoPenalty.toFixed(2)}`);
      }
    }

    if (candidate.price && candidate.price > 0) {
      score += 0.08;
      reasons.push("has-price");
    }

    if (category !== "magazine" && category !== "merch" && isLikelyCorrectEdition(item, title)) {
      score += 0.18;
      reasons.push("edition-match");
    }

    if (category !== "magazine" && category !== "merch" && hasEditionConflict(wanted, title)) {
      score -= 0.45;
      reasons.push("edition-conflict");
    }

    if (hasMagazineIssueConflict(item, title)) {
      score -= 1.2;
      reasons.push("magazine-issue-conflict");
    }

    if (hasWeakGuideSignals(item, title)) {
      score -= 0.35;
      reasons.push("weak-guide-signal");
    }

    if (hasMagazineSignals(title) && category === "guide") {
      score -= 0.4;
      reasons.push("magazine-like-guide");
    }

    if (hasNarrativeSignals(title)) {
      score -= 0.35;
      reasons.push("narrative-signal");
    }

    if (category === "magazine" && hasMagazineSupplementSignals(title)) {
      score -= 0.45;
      reasons.push("magazine-supplement-signal");
    }

    if (
      category === "guide" &&
      candidate.price != null &&
      candidate.price < 12 &&
      !hasPremiumGuideSignal(title)
    ) {
      score -= 0.3;
      reasons.push("suspicious-low-guide-price");
    }

    return {
      candidate,
      score,
      reasons
    };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log(
    "🏺 Todocoleccion top:",
    scored.slice(0, 5).map((entry) => ({
      title: entry.candidate.title,
      score: Number(entry.score.toFixed(2)),
      reasons: entry.reasons,
      price: entry.candidate.price
    }))
  );

  const best = scored[0];

  if (!best) return null;
  if (best.score < MIN_ACCEPTED_SCORE) return null;

  if (isUnreliableOfficialGuideCandidate(item, best.candidate)) {
    console.log("🏺 Todocoleccion rejected unreliable official guide:", {
      title: best.candidate.title,
      price: best.candidate.price
    });

    return null;
  }

  return best;
}

async function buildResult(
  item: Item,
  candidate: Candidate,
  query: string
): Promise<ScraperSourceResult | null> {
  const detail = await fetchDetail(candidate.url);

  const finalPrice =
    detail?.price && detail.price > 0
      ? detail.price
      : candidate.price;

  if (!finalPrice || finalPrice <= 0) return null;

  const matchedTitle = detail?.title || candidate.title;
  const normalizedMatchedTitle = normalizeSearchText(matchedTitle);
  const category = normalizeCategory(item.category);
  const platform = normalizePlatform(item.platform);

  if (hasDisallowedMagazineVariant(item, normalizedMatchedTitle)) {
    return null;
  }

  if (category === "magazine" && !isMainMagazineCandidate(item, normalizedMatchedTitle)) {
    return null;
  }

  if (category === "merch" && platform === "stack") {
    if (!passesStackCandidateValidation(item, normalizedMatchedTitle)) {
      return null;
    }
  }

  if (category === "merch" && platform === "tazo") {
    if (!passesTazoCandidateValidation(item, normalizedMatchedTitle)) {
      return null;
    }
  }

  if (
    category !== "magazine" &&
    category !== "merch" &&
    hasEditionConflict(normalizeSearchText(item.name), normalizedMatchedTitle)
  ) {
    return null;
  }

  if (!passesIdentityRequirements(item, normalizedMatchedTitle)) {
    return null;
  }

  if (hasMagazineIssueConflict(item, normalizedMatchedTitle)) {
    return null;
  }

  const confidence = computeConfidence(item, matchedTitle);

  return {
    price: Number(finalPrice.toFixed(2)),
    currency: "EUR",
    source: "todocoleccion",
    confidence,
    matchedTitle,
    matchedUrl: candidate.url,
    query,
    metadata: {
      provider: "todocoleccion",
      currency: "EUR",
      url: candidate.url,
      category: item.category,
      platform: item.platform ?? null,
      completeness: item.completeness ?? null,
      region: item.region ?? null,
      magazineIssue: extractMagazineIssue(item.name),
      stackCollectionMode:
        category === "merch" && platform === "stack"
          ? getStackCollectionMode(item, normalizedMatchedTitle)
          : null,
      tazoCollectionMode:
        category === "merch" && platform === "tazo"
          ? getTazoCollectionMode(item, normalizedMatchedTitle)
          : null,
      priceRole: "listing",
      liquidity: "low"
    }
  };
}

async function fetchDetail(
  url: string
): Promise<{ title: string | null; price: number | null } | null> {
  const html = await fetchHtml(url, DIRECT_DETAIL_TIMEOUT_MS);

  if (!html) return null;

  const $ = cheerio.load(html);

  const title =
    $("h1").first().text().trim() ||
    $("meta[property='og:title']").attr("content")?.trim() ||
    $("title").text().trim() ||
    titleFromUrl(url);

  const price =
    parsePrice($("[class*='price']").first().text().trim()) ??
    parsePrice($("[class*='precio']").first().text().trim()) ??
    parsePrice($("meta[property='product:price:amount']").attr("content")) ??
    extractPriceFromJson(html) ??
    parsePrice($("body").text());

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
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language":
          "es-ES,es;q=0.9,en;q=0.8",
        Referer: BASE_URL
      }
    });

    if (!res.ok) {
      console.log("❌ Todocoleccion fetch failed:", res.status, url);
      return null;
    }

    return await res.text();
  } catch (error) {
    console.log("❌ Todocoleccion fetch error:", {
      url,
      error
    });

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parsePrice(value: string | null | undefined): number | null {
  const text = String(value || "").trim();

  if (!text) return null;

  const euroMatches = [
    ...text.matchAll(/(\d{1,5}(?:[.,]\d{1,2})?)\s*€/g)
  ];

  if (euroMatches.length > 0) {
    return parseEuroPrice(euroMatches[0][1]);
  }

  return parseEuroPrice(text);
}

function extractPriceFromJson(html: string): number | null {
  const matches = [
    ...html.matchAll(/"price"\s*:\s*"?(\d+(?:[.,]\d+)?)"?/g)
  ];

  const prices = matches
    .map((match) => Number(String(match[1]).replace(",", ".")))
    .filter((price) => Number.isFinite(price) && price > 0);

  return prices[0] ?? null;
}

function getImportantTokens(
  normalizedText: string,
  item: Item
): string[] {
  const category = normalizeCategory(item.category);

  const stopWords = new Set([
    "the",
    "and",
    "para",
    "con",
    "del",
    "los",
    "las",
    "una",
    "uno",
    "oficial",
    "official",
    "guide",
    "guia",
    "guía",
    "magazine",
    "revista"
  ]);

  if (category === "magazine") {
    [
      "numero",
      "número",
      "num",
      "n",
      "nº",
      "no",
      "ano",
      "año",
      "suplemento",
      "coleccionable",
      "especial"
    ].forEach((word) => stopWords.add(word));
  }

  const platformWords = getPlatformWords(item.platform);

  for (const word of platformWords) {
    stopWords.add(word);
  }

  return normalizedText
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length > 1)
    .filter((token) => !stopWords.has(token));
}

function passesCategoryValidation(item: Item, title: string): boolean {
  const category = normalizeCategory(item.category);
  const platform = normalizePlatform(item.platform);

  if (category === "guide") {
    if (platform === "officialguide" || platform === "guide") {
      return hasAny(title, [
        "guide",
        "guia",
        "guía",
        "piggyback",
        "official",
        "oficial",
        "strategy",
        "estrategia",
        "bradygames",
        "future press"
      ]);
    }

    return hasAny(title, [
      "guide",
      "guia",
      "guía",
      "piggyback",
      "official",
      "oficial",
      "strategy",
      "estrategia"
    ]);
  }

  if (category === "magazine") {
    return hasMagazineSignals(title);
  }

  if (category === "merch") {
    if (platform === "tazo") {
      return hasAny(title, ["tazo", "tazos", "roller", "rollers"]);
    }

    if (platform === "stack") {
      return hasAny(title, [
        "stack",
        "stacks",
        "staks",
        "iman",
        "imán",
        "imanes",
        "album",
        "álbum",
        "coleccion",
        "colección"
      ]);
    }

    if (platform === "album") return hasAny(title, ["album", "álbum"]);
    if (platform === "gachapon") return hasAny(title, ["gachapon", "gashapon"]);
  }

  return true;
}

function passesMagazineTokenValidation(
  item: Item,
  normalizedTitle: string
): boolean {
  const wanted = normalizeSearchText(item.name);

  if (!passesMagazineBrandValidation(wanted, normalizedTitle)) {
    return false;
  }

  const wantedBase = getMagazineBaseTokens(wanted);
  const candidateBase = getMagazineBaseTokens(normalizedTitle);

  if (wantedBase.length === 0) return false;

  const baseMatches = wantedBase.filter((token) =>
    candidateBase.includes(token)
  );

  const baseRatio = baseMatches.length / wantedBase.length;

  if (baseRatio < 0.75) return false;

  const wantedIssue = extractMagazineIssue(item.name);

  if (wantedIssue) {
    const candidateIssue = extractMagazineIssue(normalizedTitle);

    if (!candidateIssue) return false;

    return candidateIssue === wantedIssue;
  }

  return true;
}

function passesMagazineBrandValidation(wanted: string, candidate: string): boolean {
  if (wanted.includes("hobby consolas")) {
    return candidate.includes("hobby consolas") || candidate.includes("hobbyconsolas");
  }

  if (wanted.includes("micro hobby")) {
    return candidate.includes("micro hobby");
  }

  if (wanted.includes("todo sega")) {
    return candidate.includes("todo sega");
  }

  if (wanted.includes("playmania") || wanted.includes("play mania")) {
    return candidate.includes("playmania") || candidate.includes("play mania");
  }

  return true;
}

function isMainMagazineCandidate(item: Item, title: string): boolean {
  const category = normalizeCategory(item.category);

  if (category !== "magazine") return true;

  const wanted = normalizeSearchText(item.name);
  const candidate = normalizeSearchText(title);

  if (hasDisallowedMagazineVariant(item, candidate)) return false;

  if (!passesMagazineBrandValidation(wanted, candidate)) return false;

  const wantedIssue = extractMagazineIssue(wanted);
  const candidateIssue = extractMagazineIssue(candidate);

  if (wantedIssue && candidateIssue !== wantedIssue) return false;

  if (wanted.includes("hobby consolas")) {
    const hasMainMagazinePattern =
      /\brevista\s+hobby\s*consolas\b/.test(candidate) ||
      /\bhobby\s*consolas\s+(?:n|numero|num|nº|n°)\s*\d{1,4}\b/.test(candidate) ||
      /\bhobbyconsolas\s+revista\s+(?:n|numero|num|nº|n°)?\s*\d{1,4}\b/.test(candidate) ||
      /\bhobby\s*consolas\s+ano\s+[ivxlcdm]+\s+(?:n|numero|num|nº|n°)?\s*\d{1,4}\b/.test(candidate);

    if (!hasMainMagazinePattern) return false;
  }

  return true;
}

function passesStackCandidateValidation(item: Item, title: string): boolean {
  const wanted = normalizeSearchText(item.name);
  const candidate = normalizeSearchText(title);

  if (!hasAny(candidate, ["pokemon", "pokémon"])) return false;

  if (!hasAny(candidate, ["stack", "stacks", "staks", "iman", "imán", "imanes"])) {
    return false;
  }

  if (wanted.includes("johto") && !candidate.includes("johto")) {
    return false;
  }

  if (isCompleteCollectionItem(item)) {
    return hasCompleteCollectionSignals(candidate);
  }

  if (isAlbumOnlyItem(item)) {
    return hasAlbumSignals(candidate) && !hasSingleStackSignals(candidate);
  }

  if (!isCompleteCollectionItem(item) && hasCompleteCollectionSignals(candidate)) {
    return false;
  }

  return true;
}

function passesTazoCandidateValidation(item: Item, title: string): boolean {
  const wanted = normalizeSearchText(item.name);
  const candidate = normalizeSearchText(title);

  if (!hasAny(candidate, ["pokemon", "pokémon"])) return false;
  if (!hasAny(candidate, ["tazo", "tazos", "roller", "rollers"])) return false;

  if (wanted.includes("mew") && !candidate.includes("mew")) return false;

  if (isCompleteCollectionItem(item)) {
    return hasCompleteCollectionSignals(candidate);
  }

  if (isAlbumOnlyItem(item)) {
    return hasAlbumSignals(candidate) && !hasSingleTazoSignals(candidate);
  }

  if (!isCompleteCollectionItem(item) && hasCompleteCollectionSignals(candidate)) {
    return false;
  }

  if (hasTazoWrongProductFamilySignals(candidate)) {
    return false;
  }

  return true;
}

function hasTazoWrongProductFamilySignals(title: string): boolean {
  return hasAny(title, [
    "staks",
    "stack",
    "stacks",
    "iman",
    "imán",
    "imanes",
    "metal tag",
    "metaltags",
    "metal tags",
    "chapa",
    "gigan tazo",
    "gigantazo",
    "oro brillo"
  ]);
}

function getTazoBoost(item: Item, title: string): number {
  const wanted = normalizeSearchText(item.name);

  if (isCompleteCollectionItem(item)) {
    let boost = 0;

    if (hasCompleteCollectionSignals(title)) boost += 1.1;
    if (title.includes("pokemon") || title.includes("pokémon")) boost += 0.1;
    if (hasAny(title, ["tazo", "tazos", "rollers"])) boost += 0.15;

    return Math.min(1.5, boost);
  }

  let boost = 0;

  if (hasAny(title, ["tazo", "tazos"])) boost += 0.25;
  if (wanted.includes("mew") && title.includes("mew")) boost += 0.25;
  if (title.includes("151")) boost += 0.18;
  if (title.includes("league 2")) boost += 0.16;
  if (title.includes("matutano")) boost += 0.12;

  if (hasSingleTazoSignals(title)) boost += 0.12;

  return Math.min(0.9, boost);
}

function getTazoPenalty(item: Item, title: string): number {
  let penalty = 0;

  if (!isCompleteCollectionItem(item) && hasCompleteCollectionSignals(title)) {
    penalty += 1.2;
  }

  if (hasTazoWrongProductFamilySignals(title)) {
    penalty += 1.0;
  }

  if (isCompleteCollectionItem(item) && hasSingleTazoSignals(title)) {
    penalty += 0.9;
  }

  return Math.min(2.0, penalty);
}

function hasSingleTazoSignals(title: string): boolean {
  return (
    /\bn\s*\.?\s*\d{1,4}\b/.test(title) ||
    /\bnº\s*\d{1,4}\b/.test(title) ||
    /\bnumero\s*\d{1,4}\b/.test(title) ||
    /\bnum\s*\d{1,4}\b/.test(title) ||
    /#\s*\d{1,4}\b/.test(title) ||
    hasAny(title, [
      "individual",
      "suelto",
      "suelta",
      "vs",
      "league 2",
      "matutano"
    ])
  );
}

function getTazoCollectionMode(item: Item, title: string): string {
  if (isCompleteCollectionItem(item) && hasCompleteCollectionSignals(title)) {
    return "complete_collection";
  }

  if (hasAlbumSignals(title) && !hasSingleTazoSignals(title)) {
    return "album";
  }

  if (hasSingleTazoSignals(title)) {
    return "single";
  }

  return "unknown";
}

function isCompleteCollectionItem(item: Item): boolean {
  const text = normalizeSearchText(
    `${item.name} ${item.platform ?? ""} ${item.completeness ?? ""} ${item.notes ?? ""}`
  );

  if (
    hasAny(text, [
      "incomplete",
      "incompleto",
      "incompleta",
      "partial",
      "parcial",
      "loose",
      "suelto",
      "suelta"
    ])
  ) {
    return false;
  }

  return (
    hasAny(text, [
      "coleccion completa",
      "colección completa",
      "set completo",
      "full set"
    ]) ||
    /\bcomplete\b/.test(text) ||
    /\bcompleto\b/.test(text) ||
    /\bcompleta\b/.test(text) ||
    /\b\d{2,4}\s*\/\s*\d{2,4}\b/.test(text)
  );
}

function isAlbumOnlyItem(item: Item): boolean {
  const text = normalizeSearchText(
    `${item.name} ${item.platform ?? ""} ${item.completeness ?? ""} ${item.notes ?? ""}`
  );

  return hasAny(text, [
    "album",
    "álbum",
    "vacio",
    "vacío",
    "empty album"
  ]);
}

function hasCompleteCollectionSignals(title: string): boolean {
  return (
    hasAny(title, [
      "coleccion completa",
      "colección completa",
      "completa con album",
      "completa con álbum",
      "album completo",
      "álbum completo",
      "set completo",
      "full set",
      "completo"
    ]) ||
    /\b\d{2,4}\s*\/\s*\d{2,4}\b/.test(title)
  );
}

function hasAlbumSignals(title: string): boolean {
  return hasAny(title, ["album", "álbum"]);
}

function hasSingleStackSignals(title: string): boolean {
  return (
    /\bn\s*\.?\s*\d{1,4}\b/.test(title) ||
    /\bnº\s*\d{1,4}\b/.test(title) ||
    /\bnumero\s*\d{1,4}\b/.test(title) ||
    /\bnum\s*\d{1,4}\b/.test(title) ||
    hasAny(title, [
      "iman",
      "imán",
      "cromo",
      "individual",
      "suelto",
      "suelta"
    ])
  );
}

function getStackCollectionBoost(item: Item, title: string): number {
  if (!isCompleteCollectionItem(item)) {
    return 0;
  }

  let boost = 0;

  if (hasCompleteCollectionSignals(title)) boost += 1.2;
  if (hasAlbumSignals(title)) boost += 0.25;
  if (title.includes("johto")) boost += 0.2;
  if (title.includes("panini")) boost += 0.1;
  if (title.includes("260/260") || title.includes("260 260")) boost += 0.4;

  return Math.min(1.8, boost);
}

function getStackCollectionPenalty(item: Item, title: string): number {
  if (!isCompleteCollectionItem(item)) {
    return hasCompleteCollectionSignals(title) ? 0.7 : 0;
  }

  let penalty = 0;

  if (hasSingleStackSignals(title)) penalty += 1.2;
  if (hasAny(title, ["nº", "numero", "num"])) penalty += 0.35;
  if (!hasCompleteCollectionSignals(title)) penalty += 0.8;

  return Math.min(2.0, penalty);
}

function getStackCollectionMode(item: Item, title: string): string {
  if (isCompleteCollectionItem(item) && hasCompleteCollectionSignals(title)) {
    return "complete_collection";
  }

  if (hasAlbumSignals(title) && !hasSingleStackSignals(title)) {
    return "album";
  }

  if (hasSingleStackSignals(title)) {
    return "single";
  }

  return "unknown";
}

function hasDisallowedMagazineVariant(item: Item, title: string): boolean {
  const category = normalizeCategory(item.category);

  if (category !== "magazine") return false;

  const wanted = normalizeSearchText(item.name);
  const candidate = normalizeSearchText(title);

  const userWantsSupplement = hasAny(wanted, [
    "suplemento",
    "coleccionable",
    "guia",
    "guía",
    "trucos",
    "poster book",
    "cd",
    "dvd",
    "vhs"
  ]);

  if (!userWantsSupplement && hasMagazineSupplementSignals(candidate)) {
    return true;
  }

  if (
    !userWantsSupplement &&
    hasAny(candidate, [
      "guia",
      "guía",
      "guias",
      "guías",
      "trucos",
      "poster book",
      "mangas videogames",
      "mangas & videogames"
    ])
  ) {
    return true;
  }

  if (!userWantsSupplement && hasHardMagazineAccessorySignal(candidate)) {
    return true;
  }

  if (hasMagazineBundleSignals(candidate)) {
    return true;
  }

  if (
    wanted.includes("hobby consolas") &&
    hasAny(candidate, [
      "video juegos 2007",
      "videojuegos 2007",
      "juegos y cia",
      "juegos y cía",
      "todo sega",
      "micro hobby",
      "todovhs",
      "todo vhs",
      "edicion hobby consolas",
      "edición hobby consolas"
    ])
  ) {
    return true;
  }

  return false;
}

function getMagazineBaseTokens(value: string): string[] {
  const normalized = normalizeSearchText(value);

  const stopWords = new Set([
    "revista",
    "magazine",
    "numero",
    "número",
    "num",
    "n",
    "nº",
    "no",
    "ano",
    "año",
    "vol",
    "volumen",
    "volume",
    "suplemento",
    "coleccionable",
    "especial",
    "solo",
    "el",
    "la",
    "de",
    "del",
    "con",
    "sin"
  ]);

  return normalized
    .split(" ")
    .filter(Boolean)
    .filter((token) => !stopWords.has(token))
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !/^[ivxlcdm]{1,6}$/.test(token));
}

function hasStrongNegativeSignals(item: Item, title: string): boolean {
  const category = normalizeCategory(item.category);

  if (
    category === "guide" &&
    hasAny(title, [
      "comic",
      "cómic",
      "novela",
      "resumen",
      "argumental",
      "poster",
      "posterbook",
      "llavero",
      "figura",
      "muñeco",
      "bso",
      "soundtrack",
      "dvd",
      "juego ps",
      "videojuego",
      "solo disco",
      "faltan instrucciones",
      "sin guia",
      "sin guía"
    ])
  ) {
    return true;
  }

  if (category === "magazine") {
    if (
      hasAny(title, [
        "todovhs",
        "todo vhs",
        "episodio",
        "episodios",
        "anime",
        "dragon ball gt",
        "dragon ball z",
        "edicion hobby consolas",
        "edición hobby consolas",
        "soundtrack",
        "bso",
        "llavero",
        "figura",
        "muñeco",
        "videojuego",
        "solo disco",
        "juego ps",
        "playstation 2 pal",
        "ps2 pal",
        "xbox",
        "nintendo ds",
        "cassette"
      ])
    ) {
      return true;
    }

    if (hasHardMagazineAccessorySignal(title)) {
      return true;
    }
  }

  return false;
}

function hasWeakGuideSignals(item: Item, title: string): boolean {
  const category = normalizeCategory(item.category);

  if (category !== "guide") return false;

  return !hasAny(title, [
    "piggyback",
    "official guide",
    "guia oficial",
    "guía oficial",
    "strategy guide",
    "guia estrategia",
    "guía estrategia",
    "estrategia oficial",
    "bradygames",
    "future press"
  ]);
}

function hasMagazineSignals(title: string): boolean {
  return hasAny(title, [
    "revista",
    "magazine",
    "hobby consolas",
    "hobbyconsolas",
    "playmania",
    "play mania",
    "play2mania",
    "play2 mania",
    "planet station",
    "micro hobby",
    "todo sega",
    "juegos y cia",
    "juegos y cía"
  ]);
}

function hasMagazineSupplementSignals(title: string): boolean {
  return hasAny(title, [
    "suplemento",
    "coleccionable",
    "solo el suplemento",
    "solo suplemento"
  ]);
}

function hasHardMagazineAccessorySignal(title: string): boolean {
  return (
    /\bcd\b/.test(title) ||
    /\bdvd\b/.test(title) ||
    /\bvhs\b/.test(title) ||
    /\bcassette\b/.test(title) ||
    title.includes("todovhs") ||
    title.includes("todo vhs") ||
    title.includes("contiene cd") ||
    title.includes("incluye cd") ||
    title.includes("con cd") ||
    title.includes("caratula") ||
    title.includes("carátula")
  );
}

function hasMagazineBundleSignals(title: string): boolean {
  return Boolean(
    title.match(/\b\d{1,4}\s*(?:al|a|-)\s*\d{1,4}\b/) ||
      title.match(/\bnumero\s+\d{1,4}\s+y\s+\d{1,4}\b/) ||
      title.match(/\bnúmero\s+\d{1,4}\s+y\s+\d{1,4}\b/)
  );
}

function hasNarrativeSignals(title: string): boolean {
  return hasAny(title, [
    "novela",
    "comic",
    "cómic",
    "manga",
    "argumental",
    "visual arts",
    "arte de",
    "leyenda"
  ]);
}

function getCategoryBoost(item: Item, normalizedTitle: string): number {
  const category = normalizeCategory(item.category);
  const platform = normalizePlatform(item.platform);

  if (category === "guide") {
    if (hasPremiumGuideSignal(normalizedTitle)) return 0.28;

    if (
      hasAny(normalizedTitle, [
        "guide",
        "guia",
        "guía",
        "oficial",
        "official",
        "strategy",
        "estrategia"
      ])
    ) {
      return 0.18;
    }
  }

  if (category === "magazine" && hasMagazineSignals(normalizedTitle)) {
    return 0.2;
  }

  if (category === "merch") {
    if (platform === "tazo" && hasAny(normalizedTitle, ["tazo", "tazos"])) {
      return 0.2;
    }

    if (
      platform === "stack" &&
      hasAny(normalizedTitle, [
        "stack",
        "stacks",
        "staks",
        "iman",
        "imán",
        "imanes",
        "album",
        "álbum",
        "coleccion",
        "colección"
      ])
    ) {
      return 0.2;
    }

    if (platform === "album" && hasAny(normalizedTitle, ["album", "álbum"])) {
      return 0.18;
    }

    if (
      platform === "gachapon" &&
      hasAny(normalizedTitle, ["gachapon", "gashapon"])
    ) {
      return 0.18;
    }
  }

  return 0;
}

function computeConfidence(item: Item, matchedTitle: string): number {
  const wanted = normalizeSearchText(item.name);
  const matched = normalizeSearchText(matchedTitle);
  const category = normalizeCategory(item.category);
  const platform = normalizePlatform(item.platform);

  let confidence = 0.42 + similarityScore(wanted, matched) * 0.42;

  if (matched.includes(wanted)) confidence += 0.08;

  if (category !== "magazine" && category !== "merch" && isLikelyCorrectEdition(item, matched)) {
    confidence += 0.08;
  }

  if (category !== "magazine" && category !== "merch" && hasEditionConflict(wanted, matched)) {
    confidence -= 0.25;
  }

  confidence += getCategoryBoost(item, matched);
  confidence += getIdentityBoost(item, matched);
  confidence += getMagazineIdentityBoost(item, matched);

  if (category === "magazine" && hasMagazineSupplementSignals(matched)) {
    confidence -= 0.15;
  }

  if (category === "merch" && platform === "stack") {
    if (isCompleteCollectionItem(item) && hasCompleteCollectionSignals(matched)) {
      confidence += 0.18;
    }

    if (isCompleteCollectionItem(item) && hasSingleStackSignals(matched)) {
      confidence -= 0.35;
    }
  }

  if (category === "merch" && platform === "tazo") {
    if (isCompleteCollectionItem(item) && hasCompleteCollectionSignals(matched)) {
      confidence += 0.16;
    }

    if (!isCompleteCollectionItem(item) && hasTazoWrongProductFamilySignals(matched)) {
      confidence -= 0.35;
    }

    if (!isCompleteCollectionItem(item) && hasSingleTazoSignals(matched)) {
      confidence += 0.08;
    }
  }

  return Number(Math.max(0.25, Math.min(0.92, confidence)).toFixed(2));
}

function passesIdentityRequirements(item: Item, normalizedTitle: string): boolean {
  const category = normalizeCategory(item.category);

  if (category !== "guide") return true;

  const requirements = extractIdentityRequirements(item);

  if (requirements.length === 0) return true;

  for (const requirement of requirements) {
    if (!matchesIdentityRequirement(normalizedTitle, requirement)) {
      return false;
    }
  }

  return true;
}

function extractIdentityRequirements(item: Item): string[] {
  const category = normalizeCategory(item.category);

  if (category !== "guide") return [];

  const wanted = normalizeSearchText(`${item.name} ${item.platform ?? ""}`);
  const requirements = new Set<string>();

  if (wanted.includes("piggyback")) requirements.add("piggyback");
  if (wanted.includes("bradygames")) requirements.add("bradygames");
  if (wanted.includes("future press")) requirements.add("future_press");

  if (
    hasAny(wanted, [
      "guia oficial",
      "guía oficial",
      "official guide",
      "guia de estrategia oficial",
      "guía de estrategia oficial",
      "official strategy guide",
      "estrategia oficial"
    ])
  ) {
    requirements.add("official_guide");
  }

  return [...requirements];
}

function matchesIdentityRequirement(
  normalizedTitle: string,
  requirement: string
): boolean {
  if (requirement === "piggyback") return normalizedTitle.includes("piggyback");
  if (requirement === "bradygames") return normalizedTitle.includes("bradygames");
  if (requirement === "future_press") return normalizedTitle.includes("future press");

  if (requirement === "official_guide") {
    return hasAny(normalizedTitle, [
      "guia oficial",
      "guía oficial",
      "official guide",
      "guia estrategia oficial",
      "guía estrategia oficial",
      "guia de estrategia oficial",
      "guía de estrategia oficial",
      "la guia de estrategia oficial",
      "la guía de estrategia oficial",
      "official strategy guide",
      "estrategia oficial"
    ]);
  }

  return true;
}

function getIdentityBoost(item: Item, normalizedTitle: string): number {
  const requirements = extractIdentityRequirements(item);

  if (requirements.length === 0) return 0;

  const matches = requirements.filter((requirement) =>
    matchesIdentityRequirement(normalizedTitle, requirement)
  );

  if (matches.length === 0) return 0;

  return Math.min(0.25, matches.length * 0.12);
}

function hasPremiumGuideSignal(title: string): boolean {
  return hasAny(title, [
    "piggyback",
    "bradygames",
    "future press",
    "official guide",
    "guia oficial",
    "guía oficial",
    "strategy guide",
    "guia estrategia oficial",
    "guía estrategia oficial",
    "guia de estrategia oficial",
    "guía de estrategia oficial",
    "estrategia oficial"
  ]);
}

function getMagazineIdentityBoost(item: Item, normalizedTitle: string): number {
  const category = normalizeCategory(item.category);

  if (category !== "magazine") return 0;

  const wantedIssue = extractMagazineIssue(item.name);
  const candidateIssue = extractMagazineIssue(normalizedTitle);

  let boost = 0;

  if (wantedIssue && candidateIssue && wantedIssue === candidateIssue) {
    boost += 0.35;
  }

  const wantedBase = getMagazineBaseTokens(item.name);
  const candidateBase = getMagazineBaseTokens(normalizedTitle);

  const baseMatches = wantedBase.filter((token) =>
    candidateBase.includes(token)
  );

  if (wantedBase.length > 0 && baseMatches.length === wantedBase.length) {
    boost += 0.25;
  }

  if (hasMagazineSignals(normalizedTitle)) {
    boost += 0.12;
  }

  return Math.min(0.55, boost);
}

function hasMagazineIssueConflict(item: Item, normalizedTitle: string): boolean {
  const category = normalizeCategory(item.category);

  if (category !== "magazine") return false;

  const wantedIssue = extractMagazineIssue(item.name);

  if (!wantedIssue) return false;

  const candidateIssue = extractMagazineIssue(normalizedTitle);

  if (!candidateIssue) return true;

  return wantedIssue !== candidateIssue;
}

function extractMagazineIssue(value: string): string | null {
  const normalized = normalizeSearchText(value)
    .replace(/n\s*º/g, "nº")
    .replace(/n\s*°/g, "n°")
    .replace(/num\./g, "num ")
    .replace(/n\./g, "num ")
    .replace(/nº/g, " numero ")
    .replace(/n°/g, " numero ")
    .replace(/no\./g, " numero ")
    .replace(/\baño\b/g, "ano")
    .replace(/\s+/g, " ")
    .trim();

  const explicit = normalized.match(/\b(?:numero|num|n)\s*(\d{1,4})\b/);

  if (explicit?.[1]) return normalizeIssueNumber(explicit[1]);

  const hobbyConsolasDirect = normalized.match(
    /\bhobby\s*consolas\s+(\d{1,4})\b/
  );

  if (hobbyConsolasDirect?.[1]) {
    return normalizeIssueNumber(hobbyConsolasDirect[1]);
  }

  const hobbyConsolasWithRomanYear = normalized.match(
    /\bhobby\s*consolas\s+ano\s+[ivxlcdm]+\s+(\d{1,4})\b/
  );

  if (hobbyConsolasWithRomanYear?.[1]) {
    return normalizeIssueNumber(hobbyConsolasWithRomanYear[1]);
  }

  const revistaDirect = normalized.match(
    /\brevista\s+hobby\s*consolas\s+(\d{1,4})\b/
  );

  if (revistaDirect?.[1]) {
    return normalizeIssueNumber(revistaDirect[1]);
  }

  return null;
}

function normalizeIssueNumber(value: string): string {
  const numeric = Number(value);

  if (Number.isFinite(numeric)) {
    return String(numeric);
  }

  return String(value).replace(/^0+/, "") || value;
}

function removeMagazineIssueWords(value: string): string {
  return normalizeSearchText(value)
    .replace(/\b(?:numero|número|num|n|nº|n°)\s*\d{1,4}\b/g, "")
    .replace(/\bhobby\s*consolas\s+\d{1,4}\b/g, "hobby consolas")
    .replace(/\brevista\s+hobby\s*consolas\s+\d{1,4}\b/g, "revista hobby consolas")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyCorrectEdition(item: Item, title: string): boolean {
  const wanted = normalizeSearchText(item.name);

  return !hasEditionConflict(wanted, title);
}

function hasEditionConflict(wanted: string, candidate: string): boolean {
  const wantedSaga = extractSagaEdition(wanted);
  const candidateSaga = extractSagaEdition(candidate);

  if (wantedSaga && candidateSaga && wantedSaga !== candidateSaga) {
    return true;
  }

  const wantedTokens = extractEditionTokens(wanted);
  const candidateTokens = extractEditionTokens(candidate);

  if (wantedTokens.length === 0 || candidateTokens.length === 0) {
    return false;
  }

  const wantedSet = new Set(wantedTokens);

  const foreignTokens = candidateTokens.filter(
    (token) => !wantedSet.has(token)
  );

  if (foreignTokens.length === 0) return false;

  const dangerousForeignTokens = foreignTokens.filter((token) => {
    if (/^\d+$/.test(token)) return Number(token) <= 30;
    if (/^\d+-\d+$/.test(token)) return true;
    if (/^[a-z]+-\d+$/.test(token)) return true;
    if (token.startsWith("num-")) return true;

    return false;
  });

  return dangerousForeignTokens.length > 0;
}

function extractEditionTokens(value: string): string[] {
  const normalized = normalizeSearchText(value);
  const tokens = new Set<string>();

  const compactMatches = [
    ...normalized.matchAll(/\b[a-z]+(?:-| )?\d+(?:-\d+)?\b/g)
  ];

  for (const match of compactMatches) {
    tokens.add(match[0].replace(/\s+/g, "-"));
  }

  const numberedMatches = [
    ...normalized.matchAll(
      /\b(?:vol|volume|volumen|tomo|num|numero|número|n)\s*\.?\s*(\d+)\b/g
    )
  ];

  for (const match of numberedMatches) {
    tokens.add(`num-${match[1]}`);
  }

  const romanMatches = [
    ...normalized.matchAll(/\b[ivxlcdm]{1,6}(?:-\d+)?\b/g)
  ];

  for (const match of romanMatches) {
    const normalizedRoman = normalizeRomanEdition(match[0]);

    if (normalizedRoman) {
      tokens.add(normalizedRoman);
    }
  }

  return [...tokens];
}

function extractSagaEdition(value: string): string | null {
  const normalized = normalizeSearchText(value);

  const sequelRoman = normalized.match(/\b([ivxlcdm]{1,6})-(\d+)\b/i);

  if (sequelRoman?.[1] && sequelRoman?.[2]) {
    const roman = romanToNumber(sequelRoman[1]);

    if (roman != null) return `${roman}-${Number(sequelRoman[2])}`;
  }

  const sequelArabic = normalized.match(/\b(\d+)-(\d+)\b/);

  if (sequelArabic?.[1] && sequelArabic?.[2]) {
    return `${Number(sequelArabic[1])}-${Number(sequelArabic[2])}`;
  }

  const roman = normalized.match(/\b[ivxlcdm]{1,6}\b/i);

  if (roman?.[0]) {
    const converted = romanToNumber(roman[0]);

    if (converted != null) return String(converted);
  }

  const arabic = normalized.match(/\b(\d{1,3})\b/);

  if (arabic?.[1]) return String(Number(arabic[1]));

  return null;
}

function normalizeRomanEdition(value: string): string | null {
  const normalized = value
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();

  const sequel = normalized.match(/^([ivxlcdm]{1,6})-(\d+)$/);

  if (sequel?.[1] && sequel?.[2]) {
    const roman = romanToNumber(sequel[1]);

    if (roman != null) return `${roman}-${Number(sequel[2])}`;
  }

  const roman = romanToNumber(normalized);

  if (roman != null) return String(roman);

  return null;
}

function romanToNumber(value: string): number | null {
  const roman = value.toLowerCase();

  if (!/^[ivxlcdm]+$/.test(roman)) return null;

  const map: Record<string, number> = {
    i: 1,
    v: 5,
    x: 10,
    l: 50,
    c: 100,
    d: 500,
    m: 1000
  };

  let total = 0;
  let previous = 0;

  for (let i = roman.length - 1; i >= 0; i--) {
    const current = map[roman[i]];

    if (!current) return null;

    if (current < previous) {
      total -= current;
    } else {
      total += current;
    }

    previous = current;
  }

  return total > 0 ? total : null;
}

function isUnreliableOfficialGuideCandidate(
  item: Item,
  candidate: Candidate
): boolean {
  const category = normalizeCategory(item.category);
  const platform = normalizePlatform(item.platform);

  if (category !== "guide") return false;

  if (platform !== "officialguide" && platform !== "guide") {
    return false;
  }

  const title = normalizeSearchText(candidate.title);
  const hasStrongOfficialSignal = hasPremiumGuideSignal(title);

  if (!hasStrongOfficialSignal) return true;

  const requirements = extractIdentityRequirements(item);

  if (requirements.length > 0 && !passesIdentityRequirements(item, title)) {
    return true;
  }

  if (
    candidate.price != null &&
    candidate.price < 12 &&
    !title.includes("piggyback") &&
    !title.includes("bradygames") &&
    !title.includes("future press")
  ) {
    return true;
  }

  return false;
}

function normalizeCategory(value: string | null): string {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();

  if (!normalized) return "merch";
  if (normalized === "other") return "merch";

  return normalized;
}

function normalizePlatform(value: string | null): string {
  const normalized = normalizeText(value || "")
    .replace(/\s+/g, "")
    .trim();

  if (!normalized) return "";

  if (normalized.includes("officialguide")) return "officialguide";
  if (normalized.includes("strategyguide")) return "guide";
  if (normalized.includes("guide")) return "guide";
  if (normalized.includes("guia")) return "guide";
  if (normalized.includes("videogamemagazine")) return "magazine";

  if (normalized.includes("magazine") || normalized.includes("revista")) {
    return "magazine";
  }

  if (normalized.includes("tazo")) return "tazo";

  if (
    normalized.includes("stack") ||
    normalized.includes("staks") ||
    normalized.includes("iman") ||
    normalized.includes("imán")
  ) {
    return "stack";
  }

  if (normalized.includes("album") || normalized.includes("álbum")) {
    return "album";
  }

  if (normalized.includes("gachapon") || normalized.includes("gashapon")) {
    return "gachapon";
  }

  return normalized;
}

function getPlatformWords(platform: string | null): string[] {
  const type = normalizePlatform(platform);

  const words: Record<string, string[]> = {
    officialguide: ["official", "guide", "guia", "guía", "oficial"],
    guide: ["official", "guide", "guia", "guía", "oficial"],
    tazo: ["tazo", "tazos"],
    stack: ["stack", "stacks", "staks", "iman", "imán", "imanes"],
    album: ["album", "álbum"],
    gachapon: ["gachapon", "gashapon"],
    magazine: ["magazine", "revista"]
  };

  return words[type] ?? [];
}

function hasAny(value: string, tokens: string[]): boolean {
  return tokens.some((token) => value.includes(token));
}

function looksLikeProductUrl(url: string): boolean {
  const normalized = url.toLowerCase();

  if (!normalized.startsWith("http")) return false;
  if (!normalized.includes("todocoleccion.net")) return false;
  if (normalized.includes("/buscador")) return false;
  if (normalized.includes("/s/")) return false;
  if (normalized.includes("/login")) return false;
  if (normalized.includes("/carrito")) return false;

  return normalized.includes("/lote/") || normalized.includes("~x");
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "";

    return decodeURIComponent(last)
      .replace(/\.htm(l)?$/i, "")
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function normalizeSearchText(value: string): string {
  return normalizeText(value)
    .replace(/nº/g, "nº")
    .replace(/n°/g, "n°")
    .replace(/\s+/g, " ")
    .trim();
}

function clean(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function absolutize(href: string): string {
  if (!href) return "";
  if (href.startsWith("http")) return href;
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `${BASE_URL}${href}`;

  return `${BASE_URL}/${href}`;
}