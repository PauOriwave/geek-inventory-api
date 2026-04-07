import { Request, Response } from "express";
import { getAchievementsService } from "../services/achievements.service";

export async function getAchievements(req: Request, res: Response) {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const achievements = await getAchievementsService(userId);
  return res.json(achievements);
}