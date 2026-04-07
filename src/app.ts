import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import itemsRoutes from "./routes/items.routes";
import importRoutes from "./routes/import.routes";
import exportRoutes from "./routes/export.routes";
import statsRoutes from "./routes/stats.routes";
import authRoutes from "./auth/auth.routes";
import achievementsRoutes from "./routes/achievements.routes";

const app = express();

app.use(cors({
  origin: "http://localhost:3001",
  credentials: true
}));

app.use(express.json());
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/auth", authRoutes);
app.use("/items", itemsRoutes);
app.use("/import", importRoutes);
app.use("/export", exportRoutes);
app.use("/stats", statsRoutes);
app.use("/achievements", achievementsRoutes);

export default app;
