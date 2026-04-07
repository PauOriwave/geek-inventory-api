import { Router } from "express";
import { getAchievements } from "../controllers/achievements.controller";
import { requireAuth } from "../auth/auth.middleware";

const router = Router();

router.get("/", requireAuth, getAchievements);

export default router;