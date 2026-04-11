import { Router } from "express";
import {
  listWishlist,
  createWishlistItem,
  deleteWishlistItem,
  moveWishlistItemToCollection
} from "../controllers/wishlist.controller";
import { requireAuth } from "../auth/auth.middleware";

const router = Router();

router.get("/", requireAuth, listWishlist);
router.post("/", requireAuth, createWishlistItem);
router.delete("/:id", requireAuth, deleteWishlistItem);
router.post("/:id/move-to-collection", requireAuth, moveWishlistItemToCollection);

export default router;