import { Router } from "express";
import {
  listWishlist,
  createWishlistItem,
  deleteWishlistItem
} from "../controllers/wishlist.controller";
import { requireAuth } from "../auth/auth.middleware";

const router = Router();

router.get("/", requireAuth, listWishlist);
router.post("/", requireAuth, createWishlistItem);
router.delete("/:id", requireAuth, deleteWishlistItem);

export default router;