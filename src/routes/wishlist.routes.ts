import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import { requirePlan } from "../middleware/plan.middleware";
import {
  listWishlist,
  createWishlistItem,
  deleteWishlistItem,
  moveWishlistItemToCollection
} from "../controllers/wishlist.controller";

const router = Router();

router.get("/", requireAuth, listWishlist);
router.post("/", requireAuth, createWishlistItem);
router.delete("/:id", requireAuth, deleteWishlistItem);

router.post(
  "/:id/move-to-collection",
  requireAuth,
  requirePlan("premium"),
  moveWishlistItemToCollection
);

export default router;