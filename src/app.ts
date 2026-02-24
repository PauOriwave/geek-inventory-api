import itemRoutes from "./routes/items.routes";
import importRoutes from "./routes/import.routes";
import statsRoutes from "./routes/stats.routes";
import cors from "cors";
import express from "express";

const app = express();
console.log("🚀 BOOT APP", new Date().toISOString());

app.use(cors({ origin: ["http://localhost:3001"] }));
app.use(express.json());
app.use("/items", itemRoutes);
app.use("/import", importRoutes);
app.use("/stats", statsRoutes);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

export default app;

app.post("/import/items", (_req, res) => {
  res.json({ ok: true, note: "direct route hit" });
});

