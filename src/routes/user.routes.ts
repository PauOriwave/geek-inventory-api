import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";

const router = Router();

router.get("/me", requireAuth, (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  res.json(req.user);
});

export default router;