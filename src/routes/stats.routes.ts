import { Router } from "express";
import {
  getSummary,
  getByCategory,
  getTopItems,
  getCollectionHistory,
  getTrendingItems
} from "../controllers/stats.controller";

const router = Router();

router.get("/summary", getSummary);
router.get("/by-category", getByCategory);
router.get("/top-items", getTopItems);
router.get("/collection-history", getCollectionHistory);
router.get("/trending-items", getTrendingItems);

export default router;