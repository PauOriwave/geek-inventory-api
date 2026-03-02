import { Router } from "express";
import { statsSummary, statsByCategory } from "../controllers/stats.controller";

const router = Router();

router.get("/summary", statsSummary);
router.get("/by-category", statsByCategory);

export default router;