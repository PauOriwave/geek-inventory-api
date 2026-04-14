import { Router } from "express";
import { getPublicProfileByUserId } from "../controllers/users.controller";

const router = Router();

router.get("/:id/public", getPublicProfileByUserId);

export default router;