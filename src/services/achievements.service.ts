import prisma from "../prisma/client";

export type Achievement = {
  id: string;
  title: string;
  description: string;
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
      title: "First Piece",
      description: "Add your first item to the vault.",
      icon: "🧩",
      progress: totalItems,
      target: 1
    }),
    buildAchievement({
      id: "collector_initiate",
      title: "Collector Initiate",
      description: "Reach 10 items in your collection.",
      icon: "📦",
      progress: totalItems,
      target: 10
    }),
    buildAchievement({
      id: "shelf_builder",
      title: "Shelf Builder",
      description: "Reach 25 items in your collection.",
      icon: "🪵",
      progress: totalItems,
      target: 25
    }),
    buildAchievement({
      id: "vault_keeper",
      title: "Vault Keeper",
      description: "Reach 50 items in your collection.",
      icon: "🏛️",
      progress: totalItems,
      target: 50
    }),
    buildAchievement({
      id: "category_explorer",
      title: "Category Explorer",
      description: "Own items from 3 different categories.",
      icon: "🧭",
      progress: distinctCategories,
      target: 3
    }),
    buildAchievement({
      id: "valuation_rookie",
      title: "Valuation Rookie",
      description: "Generate your first valuation snapshot.",
      icon: "📈",
      progress: snapshotCount,
      target: 1
    }),
    buildAchievement({
      id: "market_watcher",
      title: "Market Watcher",
      description: "Reach 10 valuation snapshots.",
      icon: "👁️",
      progress: snapshotCount,
      target: 10
    }),
    buildAchievement({
      id: "retro_curator",
      title: "Retro Curator",
      description: "Add 5 videogames to your vault.",
      icon: "🎮",
      progress: videogames,
      target: 5
    }),
    buildAchievement({
      id: "brick_starter",
      title: "Brick Starter",
      description: "Add 3 LEGO items to your vault.",
      icon: "🧱",
      progress: lego,
      target: 3
    }),
    buildAchievement({
      id: "board_tactician",
      title: "Board Tactician",
      description: "Add 3 board games to your vault.",
      icon: "♟️",
      progress: boardgames,
      target: 3
    })
  ];
}

function buildAchievement(input: {
  id: string;
  title: string;
  description: string;
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