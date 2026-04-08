import { Router } from "express";
import {
  createItem,
  listItems,
  getItemById,
  getItemSnapshots,
  updateItem,
  deleteItem,
  valuateItem,
  valuateAllItems
} from "../controllers/items.controller";
import { requireAuth } from "../auth/auth.middleware";
import { requirePremium } from "../auth/requirePremium";

const router = Router();

router.get("/", requireAuth, listItems);
router.get("/:id", requireAuth, getItemById);
router.get("/:id/snapshots", requireAuth, getItemSnapshots);

router.post("/", requireAuth, createItem);
router.post("/valuate-all", requireAuth, requirePremium, valuateAllItems);
router.post("/:id/valuate", requireAuth, valuateItem);

router.patch("/:id", requireAuth, updateItem);
router.delete("/:id", requireAuth, deleteItem);

export default router;