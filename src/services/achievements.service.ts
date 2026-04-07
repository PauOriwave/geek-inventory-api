import prisma from "../prisma/client";

export type Achievement = {
  id: string;
  unlocked: boolean;
  progress: number;
  target: number;
  icon: string;
};

export async function getAchievementsService(userId: string): Promise<Achievement[]> {
  const [items, snapshotCount] = await Promise.all([
    prisma.item.findMany({
      where: { userId },
      select: {
        category: true
      }
    }),
    prisma.itemValuationSnapshot.count({
      where: {
        item: {
          userId
        }
      }
    })
  ]);

  const totalItems = items.length;
  const distinctCategories = new Set(items.map((item) => item.category)).size;

  const videogames = items.filter((item) => item.category === "videogame").length;
  const lego = items.filter((item) => item.category === "lego").length;
  const boardgames = items.filter((item) => item.category === "boardgame").length;

  return [
    buildAchievement({
      id: "first_piece",
      icon: "🧩",
      progress: totalItems,
      target: 1
    }),
    buildAchievement({
      id: "collector_initiate",
      icon: "📦",
      progress: totalItems,
      target: 10
    }),
    buildAchievement({
      id: "shelf_builder",
      icon: "🪵",
      progress: totalItems,
      target: 25
    }),
    buildAchievement({
      id: "vault_keeper",
      icon: "🏛️",
      progress: totalItems,
      target: 50
    }),
    buildAchievement({
      id: "category_explorer",
      icon: "🧭",
      progress: distinctCategories,
      target: 3
    }),
    buildAchievement({
      id: "valuation_rookie",
      icon: "📈",
      progress: snapshotCount,
      target: 1
    }),
    buildAchievement({
      id: "market_watcher",
      icon: "👁️",
      progress: snapshotCount,
      target: 10
    }),
    buildAchievement({
      id: "retro_curator",
      icon: "🎮",
      progress: videogames,
      target: 5
    }),
    buildAchievement({
      id: "brick_starter",
      icon: "🧱",
      progress: lego,
      target: 3
    }),
    buildAchievement({
      id: "board_tactician",
      icon: "♟️",
      progress: boardgames,
      target: 3
    })
  ];
}

function buildAchievement(input: {
  id: string;
  icon: string;
  progress: number;
  target: number;
}): Achievement {
  return {
    ...input,
    unlocked: input.progress >= input.target,
    progress: Math.min(input.progress, input.target)
  };
}