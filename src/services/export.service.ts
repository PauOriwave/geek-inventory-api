import prisma from "../prisma/client";

function escapeCsv(value: string | number) {
  const str = String(value ?? "");

  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

export async function exportItemsToCsv(userId: string) {
  const items = await prisma.item.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" }
  });

  const header = ["name", "category", "estimatedPrice", "quantity"];

  const rows = items.map((item) =>
    [
      escapeCsv(item.name),
      escapeCsv(item.category),
      escapeCsv(Number(item.estimatedPrice)),
      escapeCsv(item.quantity)
    ].join(",")
  );

  return [header.join(","), ...rows].join("\n");
}