import "dotenv/config";
import express from "express";
import cors from "cors";

import authRoutes from "./auth/auth.routes";
import itemsRoutes from "./routes/items.routes";
import statsRoutes from "./routes/stats.routes";
import achievementsRoutes from "./routes/achievements.routes";
import wishlistRoutes from "./routes/wishlist.routes";

const app = express();

app.use(
  cors({
    origin: true,
    credentials: true
  })
);

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/auth", authRoutes);
app.use("/items", itemsRoutes);
app.use("/stats", statsRoutes);
app.use("/achievements", achievementsRoutes);
app.use("/wishlist", wishlistRoutes);

export default app;