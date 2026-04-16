import prisma from "../prisma/client";

type SummaryParams = {
  userId: string;
  q?: string;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
};

type TrendKind = "rising" | "dropping" | "stable";

type ByCategoryRow = {
  category: string;
  units: number;
  value: number;
  items: number;
  trend: TrendKind;
  trendDelta: number;
};

type TopItemRow = {
  id: string;
  name: string;
  category: string;
  quantity: number;
  estimatedPrice: number;
  totalValue: number;
};

type HistoryPoint = {
  date: string;
  total: number;
};

type CollectionHistoryResponse = {
  base: HistoryPoint[];
  market: HistoryPoint[];
};

type TrendingItemRow = {
  id: string;
  name: string;
  category: string;
  firstValue: number;
  latestValue: number;
  delta: number;
};

type TrendingDirection = "rising" | "dropping";

function buildWhere({
  userId,
  q,
  category,
  minPrice,
  maxPrice
}: SummaryParams) {
  const where: any = { userId };

  if (q) {
    where.name = {
      contains: q,
      mode: "insensitive"
    };
  }

  if (category) {
    where.category = category;
  }

  if (
    (typeof minPrice === "number" && !Number.isNaN(minPrice)) ||
    (typeof maxPrice === "number" && !Number.isNaN(maxPrice))
  ) {
    where.estimatedPrice = {};

    if (typeof minPrice === "number" && !Number.isNaN(minPrice)) {
      where.estimatedPrice.gte = minPrice;
    }

    if (typeof maxPrice === "number" && !Number.isNaN(maxPrice)) {
      where.estimatedPrice.lte = maxPrice;
    }
  }

  return where;
}

function normalizeSnapshotSource(source?: string | null) {
  const value = (source ?? "").toLowerCase();

  if (
    value === "manual" ||
    value === "manual_update" ||
    value === "import" ||
    value === "import_update"
  ) {
    return "base" as const;
  }

  return "market" as const;
}

function upsertSeriesPoint(
  series: HistoryPoint[],
  point: HistoryPoint
): void {
  const last = series[series.length - 1];

  if (last && last.date === point.date) {
    last.total = point.total;
    return;
  }

  series.push(point);
}

export async function getSummaryService(params: SummaryParams) {
  const where = buildWhere(params);

  const items = await prisma.item.findMany({
    where,
    select: {
      estimatedPrice: true,
      quantity: true
    }
  });

  const totalItems = items.length;
  const totalUnits = items.reduce((acc, item) => acc + item.quantity, 0);
  const totalValue = items.reduce(
    (acc, item) => acc + Number(item.estimatedPrice) * item.quantity,
    0
  );

  return {
    totalItems,
    totalUnits,
    totalValue: Number(totalValue.toFixed(2))
  };
}

export async function getByCategoryService(
  userId: string
): Promise<ByCategoryRow[]> {
  const items = await prisma.item.findMany({
    where: { userId },
    select: {
      id: true,
      category: true,
      quantity: true,
      estimatedPrice: true,
      snapshots: {
        orderBy: {
          recordedAt: "asc"
        },
        select: {
          marketValue: true,
          recordedAt: true
        }
      }
    }
  });

  const grouped = new Map<
    string,
    {
      category: string;
      units: number;
      value: number;
      items: number;
      trendDelta: number;
    }
  >();

  for (const item of items) {
    const key = item.category;

    const current = grouped.get(key) ?? {
      category: key,
      units: 0,
      value: 0,
      items: 0,
      trendDelta: 0
    };

    current.units += item.quantity;
    current.items += 1;
    current.value += Number(item.estimatedPrice) * item.quantity;

    if (item.snapshots.length >= 2) {
      const first = Number(item.snapshots[0].marketValue);
      const latest = Number(
        item.snapshots[item.snapshots.length - 1].marketValue
      );
      current.trendDelta += latest - first;
    }

    grouped.set(key, current);
  }

  const rows: ByCategoryRow[] = [...grouped.values()].map((row) => {
    let trend: TrendKind = "stable";

    if (row.trendDelta > 0) trend = "rising";
    if (row.trendDelta < 0) trend = "dropping";

    return {
      category: row.category,
      units: row.units,
      value: Number(row.value.toFixed(2)),
      items: row.items,
      trend,
      trendDelta: Number(row.trendDelta.toFixed(2))
    };
  });

  return rows.sort((a, b) => b.value - a.value);
}

export async function getTopItemsService(
  userId: string,
  limit = 10,
  category?: string
): Promise<TopItemRow[]> {
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
      totalValue: Number(
        (Number(item.estimatedPrice) * item.quantity).toFixed(2)
      )
    }))
    .sort((a, b) => b.totalValue - a.totalValue)
    .slice(0, limit);
}

export async function getCollectionHistoryService(
  userId: string,
  category?: string
): Promise<CollectionHistoryResponse> {
  const items = await prisma.item.findMany({
    where: {
      userId,
      ...(category ? { category } : {})
    },
    select: {
      id: true,
      quantity: true,
      snapshots: {
        orderBy: {
          recordedAt: "asc"
        },
        select: {
          marketValue: true,
          recordedAt: true,
          source: true
        }
      }
    }
  });

  const events: Array<{
    itemId: string;
    recordedAt: Date;
    totalForItem: number;
    kind: "base" | "market";
  }> = [];

  for (const item of items) {
    for (const snapshot of item.snapshots) {
      events.push({
        itemId: item.id,
        recordedAt: snapshot.recordedAt,
        totalForItem: Number(snapshot.marketValue) * item.quantity,
        kind: normalizeSnapshotSource(snapshot.source)
      });
    }
  }

  events.sort((a, b) => {
    const diff = a.recordedAt.getTime() - b.recordedAt.getTime();
    if (diff !== 0) return diff;
    return a.itemId.localeCompare(b.itemId);
  });

  const latestBasePerItem = new Map<string, number>();
  const latestMarketPerItem = new Map<string, number>();

  const base: HistoryPoint[] = [];
  const market: HistoryPoint[] = [];

  let baseTotal = 0;
  let marketTotal = 0;

  for (const event of events) {
    const pointDate = event.recordedAt.toISOString();

    if (event.kind === "base") {
      const previous = latestBasePerItem.get(event.itemId) ?? 0;
      baseTotal += event.totalForItem - previous;
      latestBasePerItem.set(event.itemId, event.totalForItem);

      upsertSeriesPoint(base, {
        date: pointDate,
        total: Number(baseTotal.toFixed(2))
      });
    }

    if (event.kind === "market") {
      const previous = latestMarketPerItem.get(event.itemId) ?? 0;
      marketTotal += event.totalForItem - previous;
      latestMarketPerItem.set(event.itemId, event.totalForItem);

      upsertSeriesPoint(market, {
        date: pointDate,
        total: Number(marketTotal.toFixed(2))
      });
    }
  }

  return {
    base,
    market
  };
}

export async function getTrendingItemsService(
  userId: string,
  direction: TrendingDirection,
  limit = 5,
  category?: string
): Promise<TrendingItemRow[]> {
  const items = await prisma.item.findMany({
    where: {
      userId,
      ...(category ? { category } : {})
    },
    select: {
      id: true,
      name: true,
      category: true,
      snapshots: {
        orderBy: {
          recordedAt: "asc"
        },
        select: {
          marketValue: true,
          recordedAt: true
        }
      }
    }
  });

  const rows: TrendingItemRow[] = [];

  for (const item of items) {
    if (item.snapshots.length < 2) continue;

    const firstValue = Number(item.snapshots[0].marketValue);
    const latestValue = Number(
      item.snapshots[item.snapshots.length - 1].marketValue
    );
    const delta = Number((latestValue - firstValue).toFixed(2));

    if (direction === "rising" && delta <= 0) continue;
    if (direction === "dropping" && delta >= 0) continue;

    rows.push({
      id: item.id,
      name: item.name,
      category: item.category,
      firstValue: Number(firstValue.toFixed(2)),
      latestValue: Number(latestValue.toFixed(2)),
      delta
    });
  }

  return rows
    .sort((a, b) =>
      direction === "rising" ? b.delta - a.delta : a.delta - b.delta
    )
    .slice(0, limit);
}