import { Router } from "express";
import {
  register,
  login,
  logout,
  me,
  upgradeToPremium
} from "./auth.controller";
import { requireAuth } from "./auth.middleware";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.post("/logout", logout);

router.get("/me", requireAuth, me);

/**
 * 🔥 TEST ROUTE (luego se elimina)
 */
router.post("/upgrade", requireAuth, upgradeToPremium);

export default router;