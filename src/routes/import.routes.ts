import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../auth/auth.middleware";
import { importItems } from "../controllers/import.controller";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post(
  "/items",
  requireAuth,
  upload.single("file"),
  importItems
);

export default router;