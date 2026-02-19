import { Router } from "express";
import multer from "multer";
import { importItemsCsv } from "../controllers/import.controller";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post("/items", upload.single("file"), importItemsCsv);

export default router;
