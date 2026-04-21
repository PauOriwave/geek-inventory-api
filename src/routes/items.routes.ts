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
 * ⚠️ IMPORTANTE (DEPRECATED SEMÁNTICAMENTE)
 * Estas rutas YA NO disparan scraping.
 * Ahora son lectura de valoración persistida/cacheada.
 *
 * Mantener por compatibilidad con frontend actual.
 */
router.post("/valuate-all", requireAuth, valuateAllItems);
router.post("/:id/valuate", requireAuth, valuateItem);

/**
 * 🆕 Opcional (más semántico para futuro frontend)
 * Lectura pura de valoración
 */
router.get("/valuation/all", requireAuth, valuateAllItems);
router.get("/:id/valuation", requireAuth, valuateItem);

router.patch("/:id", requireAuth, updateItem);
router.delete("/:id", requireAuth, deleteItem);

export default router;