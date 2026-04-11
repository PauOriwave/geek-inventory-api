import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
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

/**
 * 🔓 FREE
 * Queremos que la valoración sea visible para todos
 * para alimentar gráficos, evolución y percepción de valor.
 */
router.post("/valuate-all", requireAuth, valuateAllItems);
router.post("/:id/valuate", requireAuth, valuateItem);

router.patch("/:id", requireAuth, updateItem);
router.delete("/:id", requireAuth, deleteItem);

export default router;