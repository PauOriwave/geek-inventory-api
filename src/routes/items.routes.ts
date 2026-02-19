import { Router } from "express";
import { createItem, listItems } from "../controllers/items.controller";

const router = Router();

router.get("/", listItems);
router.post("/", createItem);

export default router;

