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
};

export async function getByCategory(userId: string): Promise<ByCategoryRow[]> {
  const items = await prisma.item.findMany({
    where: { userId },
    select: {
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
      items: 0
    };

    current.units += item.quantity;
    current.value += Number(item.estimatedPrice) * item.quantity;
    current.items += 1;

    map.set(item.category, current);
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