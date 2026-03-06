import { Router } from "express";
import {
  listItems,
  getItemById,
  createItem,
  deleteItem,
  updateItem
} from "../controllers/items.controller";

const router = Router();

router.get("/", listItems);
router.post("/", createItem);
router.get("/:id", getItemById);
router.patch("/:id", updateItem);
router.delete("/:id", deleteItem);

export default router;

