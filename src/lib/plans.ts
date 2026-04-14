export type AppPlan = "free" | "premium" | "market_pro";

export function normalizePlan(plan?: string | null): AppPlan {
  if (plan === "market_pro") return "market_pro";
  if (plan === "premium") return "premium";
  return "free";
}

export function isPaidPlan(plan?: string | null) {
  const normalized = normalizePlan(plan);
  return normalized === "premium" || normalized === "market_pro";
}

export function isMarketProPlan(plan?: string | null) {
  return normalizePlan(plan) === "market_pro";
}

export function getItemLimitByPlan(plan?: string | null): number | null {
  const normalized = normalizePlan(plan);

  if (normalized === "free") return 25;
  if (normalized === "premium") return 250;

  return null;
}

export function getWishlistLimitByPlan(plan?: string | null): number | null {
  const normalized = normalizePlan(plan);

  if (normalized === "free") return 10;
  if (normalized === "premium") return 100;

  return null;
}

export function getPublicProfilePreviewLimit(
  plan?: string | null
): number {
  const normalized = normalizePlan(plan);

  if (normalized === "free") return 6;
  if (normalized === "premium") return 12;

  return 18;
}

export function hasUnlimitedItems(plan?: string | null) {
  return getItemLimitByPlan(plan) == null;
}

export function hasUnlimitedWishlist(plan?: string | null) {
  return getWishlistLimitByPlan(plan) == null;
}