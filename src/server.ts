import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import authRoutes from "./auth/auth.routes";
import itemsRoutes from "./routes/items.routes";
import wishlistRoutes from "./routes/wishlist.routes";
import achievementsRoutes from "./routes/achievements.routes";
import statsRoutes from "./routes/stats.routes";
import usersRoutes from "./routes/users.routes";
import importRoutes from "./routes/import.routes";
import internalRoutes from "./routes/internal.routes";
import { startValuationCron } from "./jobs/valuation.cron";

const app = express();

app.use(
  cors({
    origin: [
      "http://localhost:3001",
      "http://192.168.0.18:3001"
    ],
    credentials: true
  })
);

app.use(express.json());
app.use(cookieParser());

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "geek-inventory-api" });
});

app.use("/auth", authRoutes);
app.use("/items", itemsRoutes);
app.use("/wishlist", wishlistRoutes);
app.use("/achievements", achievementsRoutes);
app.use("/stats", statsRoutes);
app.use("/users", usersRoutes);
app.use("/internal", internalRoutes);

// 🔥 aseguramos que el import está montado
app.use("/import", importRoutes);


const PORT = Number(process.env.PORT) || 4000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`API running on http://localhost:${PORT}`);
});

startValuationCron();