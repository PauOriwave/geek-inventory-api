import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import { requirePlan } from "../middleware/plan.middleware";
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

const router = Router();

router.get("/", requireAuth, listItems);
router.get("/:id", requireAuth, getItemById);
router.get("/:id/snapshots", requireAuth, getItemSnapshots);

router.post("/", requireAuth, createItem);

router.post(
  "/valuate-all",
  requireAuth,
  requirePlan("premium"),
  valuateAllItems
);

router.post(
  "/:id/valuate",
  requireAuth,
  requirePlan("premium"),
  valuateItem
);

router.patch("/:id", requireAuth, updateItem);
router.delete("/:id", requireAuth, deleteItem);

export default router;