import prisma from "../prisma/client";
import {
  getPublicProfilePreviewLimit,
  normalizePlan
} from "../lib/plans";

type PublicAchievement = {
  id: string;
  label: string;
  icon: string;
};

type PublicProfileItem = {
  id: string;
  name: string;
  category: string;
  quantity: number;
  estimatedPrice: number;
  marketValue: number | null;
  createdAt: string;
};

type PublicProfileResponse = {
  id: string;
  displayName: string;
  plan: "free" | "premium" | "market_pro";
  premiumStartedAt: string | null;
  createdAt: string | null;
  stats: {
    totalItems: number;
    totalUnits: number;
    totalValue: number;
    previewLimit: number;
    hiddenItems: number;
    valuedItems: number;
  };
  achievements: {
    totalUnlocked: number;
    highlights: PublicAchievement[];
  };
  itemsPreview: PublicProfileItem[];
};

function monthsSince(dateString?: string | null) {
  if (!dateString) return 0;

  const start = new Date(dateString);
  const now = new Date();

  const months =
    (now.getFullYear() - start.getFullYear()) * 12 +
    (now.getMonth() - start.getMonth());

  return Math.max(0, months);
}

function buildPublicAchievements(params: {
  totalItems: number;
  valuedItems: number;
  premiumMonths: number;
}): PublicAchievement[] {
  const { totalItems, valuedItems, premiumMonths } = params;

  const achievements: PublicAchievement[] = [];

  if (totalItems >= 1) {
    achievements.push({
      id: "first_item",
      label: "First item",
      icon: "🏆"
    });
  }

  if (totalItems >= 10) {
    achievements.push({
      id: "ten_items",
      label: "10 items",
      icon: "🏆"
    });
  }

  if (totalItems >= 25) {
    achievements.push({
      id: "twenty_five_items",
      label: "25 items",
      icon: "🏆"
    });
  }

  if (totalItems >= 50) {
    achievements.push({
      id: "fifty_items",
      label: "50 items",
      icon: "🏆"
    });
  }

  if (valuedItems >= 1) {
    achievements.push({
      id: "first_valuation",
      label: "First valuation",
      icon: "📈"
    });
  }

  if (premiumMonths >= 1) {
    achievements.push({
      id: "collector_starter",
      label: "Collector Starter",
      icon: "🐉"
    });
  }

  if (premiumMonths >= 3) {
    achievements.push({
      id: "collector_rising",
      label: "Collector Rising",
      icon: "🐉"
    });
  }

  if (premiumMonths >= 12) {
    achievements.push({
      id: "collector_elite",
      label: "Collector Elite",
      icon: "🐉"
    });
  }

  return achievements;
}

function buildDisplayName(id: string) {
  return `Collector ${id.slice(0, 6)}`;
}

export async function getPublicProfileByUserIdService(
  userId: string
): Promise<PublicProfileResponse | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      plan: true,
      premiumStartedAt: true,
      createdAt: true
    }
  });

  if (!user) {
    return null;
  }

  const plan = normalizePlan(user.plan);
  const previewLimit = getPublicProfilePreviewLimit(plan);

  const rawItems = await prisma.item.findMany({
    where: { userId: user.id },
    select: {
      id: true,
      name: true,
      category: true,
      quantity: true,
      estimatedPrice: true,
      marketValue: true,
      createdAt: true,
      lastValuationAt: true
    }
  });

  const items = [...rawItems].sort((a, b) => {
    const aTotal = Number(a.estimatedPrice) * a.quantity;
    const bTotal = Number(b.estimatedPrice) * b.quantity;

    if (bTotal !== aTotal) {
      return bTotal - aTotal;
    }

    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  const totalItems = items.length;
  const totalUnits = items.reduce((acc, item) => acc + item.quantity, 0);
  const totalValue = items.reduce(
    (acc, item) => acc + Number(item.estimatedPrice) * item.quantity,
    0
  );
  const valuedItems = items.filter((item) => item.lastValuationAt != null).length;
  const premiumMonths = monthsSince(
    user.premiumStartedAt ? user.premiumStartedAt.toISOString() : null
  );

  const achievements = buildPublicAchievements({
    totalItems,
    valuedItems,
    premiumMonths
  });

  const itemsPreview: PublicProfileItem[] = items
    .slice(0, previewLimit)
    .map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      quantity: item.quantity,
      estimatedPrice: Number(item.estimatedPrice),
      marketValue: item.marketValue != null ? Number(item.marketValue) : null,
      createdAt: item.createdAt.toISOString()
    }));

  return {
    id: user.id,
    displayName: buildDisplayName(user.id),
    plan,
    premiumStartedAt: user.premiumStartedAt
      ? user.premiumStartedAt.toISOString()
      : null,
    createdAt: user.createdAt ? user.createdAt.toISOString() : null,
    stats: {
      totalItems,
      totalUnits,
      totalValue: Number(totalValue.toFixed(2)),
      previewLimit,
      hiddenItems: Math.max(0, totalItems - previewLimit),
      valuedItems
    },
    achievements: {
      totalUnlocked: achievements.length,
      highlights: achievements.slice(-3).reverse()
    },
    itemsPreview
  };
}