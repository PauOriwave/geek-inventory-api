import { Router } from "express";
import { exportItemsCsv } from "../controllers/export.controller";
import { requireAuth } from "../auth/auth.middleware";

const router = Router();

router.get("/items.csv", requireAuth, exportItemsCsv);

export default router;