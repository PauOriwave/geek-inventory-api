import { Router } from "express";
import {
  createItem,
  listItems,
  getItemById,
  updateItem,
  deleteItem,
  valuateItem
} from "../controllers/items.controller";
import { requireAuth } from "../auth/auth.middleware";

const router = Router();

router.get("/", requireAuth, listItems);
router.get("/:id", requireAuth, getItemById);
router.post("/", requireAuth, createItem);
router.post("/:id/valuate", requireAuth, valuateItem);
router.patch("/:id", requireAuth, updateItem);
router.delete("/:id", requireAuth, deleteItem);

export default router;