import { Router } from "express";
import {
  refreshItemValuation,
  refreshAllValuations
} from "../controllers/internal.controller";

const router = Router();

/**
 * ⚠️ IMPORTANTE
 * Estas rutas NO son para frontend público.
 * Son internas/admin/dev.
 */

router.post("/valuations/:id/refresh", refreshItemValuation);
router.post("/valuations/refresh-all", refreshAllValuations);

export default router;