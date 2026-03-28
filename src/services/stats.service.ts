import prisma from "../prisma/client";

export const getSummaryService = async (userId: string) => {
  const items = await prisma.item.findMany({
    where: { userId },
    select: {
      estimatedPrice: true,
      quantity: true
    }
  });

  const totalValue = items.reduce(
    (acc, it) => acc + Number(it.estimatedPrice) * it.quantity,
    0
  );

  const totalUnits = items.reduce((acc, it) => acc + it.quantity, 0);

  const totalItems = await prisma.item.count({
    where: { userId }
  });

  return {
    totalItems,
    totalUnits,
    totalValue
  };
};

export type ByCategoryRow = {
  category: string;
  units: number;
  value: number;
  items: number;
  trend: "rising" | "dropping" | "stable";
  trendDelta: number;
};

export async function getByCategory(userId: string): Promise<ByCategoryRow[]> {
  const items = await prisma.item.findMany({
    where: { userId },
    select: {
      id: true,
      category: true,
      quantity: true,
      estimatedPrice: true
    }
  });

  const map = new Map<string, ByCategoryRow>();

  for (const item of items) {
    const current = map.get(item.category) ?? {
      category: item.category,
      units: 0,
      value: 0,
      items: 0,
      trend: "stable" as const,
      trendDelta: 0
    };

    current.units += item.quantity;
    current.value += Number(item.estimatedPrice) * item.quantity;
    current.items += 1;

    map.set(item.category, current);
  }

  const snapshots = await prisma.itemValuationSnapshot.findMany({
    where: {
      item: {
        userId
      }
    },
    select: {
      itemId: true,
      marketValue: true,
      recordedAt: true,
      item: {
        select: {
          category: true
        }
      }
    },
    orderBy: {
      recordedAt: "asc"
    }
  });

  const byCategoryHistory = new Map<
    string,
    Array<{ itemId: string; marketValue: number; recordedAt: Date }>
  >();

  for (const snapshot of snapshots) {
    const category = snapshot.item.category;
    const list = byCategoryHistory.get(category) ?? [];

    list.push({
      itemId: snapshot.itemId,
      marketValue: Number(snapshot.marketValue),
      recordedAt: snapshot.recordedAt
    });

    byCategoryHistory.set(category, list);
  }

  for (const [category, history] of byCategoryHistory.entries()) {
    const groupedByDay = new Map<
      string,
      Array<{ itemId: string; marketValue: number }>
    >();

    for (const entry of history) {
      const day = entry.recordedAt.toISOString().slice(0, 10);
      const list = groupedByDay.get(day) ?? [];

      list.push({
        itemId: entry.itemId,
        marketValue: entry.marketValue
      });

      groupedByDay.set(day, list);
    }

    const lastKnownByItem = new Map<string, number>();
    const totals: number[] = [];

    for (const [, entries] of Array.from(groupedByDay.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      for (const entry of entries) {
        lastKnownByItem.set(entry.itemId, entry.marketValue);
      }

      const total = Array.from(lastKnownByItem.values()).reduce(
        (acc, value) => acc + value,
        0
      );

      totals.push(Number(total.toFixed(2)));
    }

    const row = map.get(category);
    if (!row || totals.length === 0) continue;

    const first = totals[0];
    const latest = totals[totals.length - 1];
    const delta = Number((latest - first).toFixed(2));

    row.trendDelta = delta;

    if (delta > 0.01) {
      row.trend = "rising";
    } else if (delta < -0.01) {
      row.trend = "dropping";
    } else {
      row.trend = "stable";
    }

    map.set(category, row);
  }

  return Array.from(map.values()).sort((a, b) => b.value - a.value);
}

export type TopItemRow = {
  id: string;
  name: string;
  category: string;
  quantity: number;
  estimatedPrice: number;
  totalValue: number;
};

export async function getTopItems(
  userId: string,
  limit = 10,
  category?: string
): Promise<TopItemRow[]> {
  const safeLimit = Math.min(50, Math.max(1, limit));

  const items = await prisma.item.findMany({
    where: {
      userId,
      ...(category ? { category } : {})
    },
    select: {
      id: true,
      name: true,
      category: true,
      quantity: true,
      estimatedPrice: true
    }
  });

  return items
    .map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      quantity: item.quantity,
      estimatedPrice: Number(item.estimatedPrice),
      totalValue: Number(item.estimatedPrice) * item.quantity
    }))
    .sort((a, b) => b.totalValue - a.totalValue)
    .slice(0, safeLimit);
}

export type CollectionHistoryPoint = {
  date: string;
  total: number;
};

export async function getCollectionValueHistory(
  userId: string,
  category?: string
): Promise<CollectionHistoryPoint[]> {
  const snapshots = await prisma.itemValuationSnapshot.findMany({
    where: {
      item: {
        userId,
        ...(category ? { category } : {})
      }
    },
    select: {
      itemId: true,
      marketValue: true,
      recordedAt: true
    },
    orderBy: {
      recordedAt: "asc"
    }
  });

  if (snapshots.length === 0) {
    return [];
  }

  const groupedByDay = new Map<
    string,
    Array<{ itemId: string; marketValue: number }>
  >();

  for (const snapshot of snapshots) {
    const day = snapshot.recordedAt.toISOString().slice(0, 10);
    const list = groupedByDay.get(day) ?? [];

    list.push({
      itemId: snapshot.itemId,
      marketValue: Number(snapshot.marketValue)
    });

    groupedByDay.set(day, list);
  }

  const lastKnownByItem = new Map<string, number>();
  const result: CollectionHistoryPoint[] = [];

  for (const [date, entries] of Array.from(groupedByDay.entries()).sort(
    (a, b) => a[0].localeCompare(b[0])
  )) {
    for (const entry of entries) {
      lastKnownByItem.set(entry.itemId, entry.marketValue);
    }

    const total = Array.from(lastKnownByItem.values()).reduce(
      (acc, value) => acc + value,
      0
    );

    result.push({
      date,
      total: Number(total.toFixed(2))
    });
  }

  return result;
}