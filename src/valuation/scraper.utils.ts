import { Item } from "@prisma/client";
import { normalizeText, similarityScore } from "./utils";

export function buildSearchText(item: Item) {
  return [item.name, item.platform ?? "", item.region ?? ""]
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join(" ");
}

export function enrichScore(
  item: Item,
  title: string,
  baseScore: number
) {
  let score = baseScore;

  const normTitle = normalizeText(title);

  if (item.platform) {
    const p = normalizeText(item.platform);
    if (normTitle.includes(p)) score += 0.1;
  }

  if (item.region) {
    const r = normalizeText(item.region);
    if (normTitle.includes(r)) score += 0.05;
  }

  return score;
}

export function computeConfidenceFromScore(score: number) {
  const confidence = 0.4 + score * 0.5;
  return Math.max(0.1, Math.min(0.95, Number(confidence.toFixed(2))));
}

export function pickBestBySimilarity<T extends { title: string }>(
  item: Item,
  candidates: T[],
  minScore = 0.25
): T | null {
  const wanted = buildSearchText(item);

  const scored = candidates.map((c) => {
    const base = similarityScore(wanted, c.title);
    const score = enrichScore(item, c.title, base);
    return { c, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < minScore) return null;

  return best.c;
}