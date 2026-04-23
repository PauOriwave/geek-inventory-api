import { Router } from "express";
import {
  refreshItemValuation,
  refreshAllValuations,
  getItemScraperLogs,
  getScraperLogs
} from "../controllers/internal.controller";

const router = Router();

/**
 * ⚠️ Estas rutas son internas/admin/dev
 */

router.post("/valuations/:id/refresh", refreshItemValuation);
router.post("/valuations/refresh-all", refreshAllValuations);

router.get("/valuations/:id/logs", getItemScraperLogs);
router.get("/valuations/logs", getScraperLogs);

export default router;