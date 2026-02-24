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