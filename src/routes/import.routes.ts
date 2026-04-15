import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { requireAuth } from "../auth/auth.middleware";
import { importItems } from "../controllers/import.controller";

console.log("✅ import.routes.ts loaded");
console.log("typeof importItems =", typeof importItems);

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

function importDebugLog(req: Request, _res: Response, next: NextFunction) {
  console.log("🔥 IMPORT HIT /import/items");
  console.log("file?", Boolean(req.file));
  console.log("user?", req.user?.id ?? null);
  next();
}

router.post(
  "/items",
  upload.single("file"),
  requireAuth,
  importDebugLog,
  importItems
);

export default router;