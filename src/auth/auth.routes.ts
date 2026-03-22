import { Router } from "express";
import { login, logout, me, register } from "./auth.controller";
import { requireAuth } from "./auth.middleware";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.post("/logout", logout);
router.get("/me", requireAuth, me);

export default router;