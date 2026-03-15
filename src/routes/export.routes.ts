import { Router } from "express";
import { exportItemsCsv } from "../controllers/export.controller";

const router = Router();

router.get("/items.csv", exportItemsCsv);

export default router;