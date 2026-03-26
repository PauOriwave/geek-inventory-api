import { Router } from "express";
import {
  statsSummary,
  statsByCategory,
  statsTopItems,
  statsCollectionHistory
} from "../controllers/stats.controller";
import { requireAuth } from "../auth/auth.middleware";

const router = Router();

router.get("/summary", requireAuth, statsSummary);
router.get("/by-category", requireAuth, statsByCategory);
router.get("/top-items", requireAuth, statsTopItems);
router.get("/collection-history", requireAuth, statsCollectionHistory);

export default router;