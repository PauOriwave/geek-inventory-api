import { Router } from "express";
import {
  getSummary,
  getByCategory,
  getTopItems,
  getCollectionHistory,
  getTrendingItems
} from "../controllers/stats.controller";
import { requireAuth } from "../auth/auth.middleware";

const router = Router();

router.get("/summary", requireAuth, getSummary);
router.get("/by-category", requireAuth, getByCategory);
router.get("/top-items", requireAuth, getTopItems);
router.get("/collection-history", requireAuth, getCollectionHistory);
router.get("/trending-items", requireAuth, getTrendingItems);

export default router;