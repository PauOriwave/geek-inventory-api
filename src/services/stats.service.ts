import prisma from "../prisma/client";

export const getSummaryService = async () => {
  const items = await prisma.item.findMany({
    select: { estimatedPrice: true, quantity: true }
  });

  const totalValue = items.reduce((acc, it) => acc + Number(it.estimatedPrice) * it.quantity, 0);
  const totalUnits = items.reduce((acc, it) => acc + it.quantity, 0);
  const totalItems = await prisma.item.count();

  return { totalItems, totalUnits, totalValue };
};

export type ByCategoryRow = {
  category: string;
  units: number;
  value: number;
  items: number;
};

export async function getByCategory(): Promise<ByCategoryRow[]> {
  // OJO: "Item" debe coincidir con tu tabla real. Con Prisma normalmente es "Item".
  const rows = await prisma.$queryRaw<ByCategoryRow[]>`
    SELECT
      "category"::text AS "category",
      COALESCE(SUM("quantity"), 0)::int AS "units",
      COALESCE(SUM(("estimatedPrice"::numeric) * ("quantity"::numeric)), 0)::float AS "value",
      COUNT(*)::int AS "items"
    FROM "Item"
    GROUP BY "category"
    ORDER BY "value" DESC;
  `;

  return rows;
}