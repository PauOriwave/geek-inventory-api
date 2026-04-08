import { Router } from "express";
import { login, register, logout, me } from "../auth/auth.controller";
import { requireAuth } from "../auth/auth.middleware";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.post("/logout", logout);
router.get("/me", requireAuth, me);

export default router;