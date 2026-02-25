import { Router } from "express";
import { createItem, listItems, deleteItem } from "../controllers/items.controller";

const router = Router();

router.get("/", listItems);
router.post("/", createItem);
router.delete("/:id", deleteItem);

export default router;

