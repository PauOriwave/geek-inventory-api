import { Router } from "express";
import { statsSummary, statsByCategory, statsTopItems } from "../controllers/stats.controller";

const router = Router();

router.get("/summary", statsSummary);
router.get("/by-category", statsByCategory);
router.get("/top-items", statsTopItems);

export default router;