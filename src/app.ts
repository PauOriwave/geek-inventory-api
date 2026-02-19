import itemRoutes from "./routes/items.routes";
import importRoutes from "./routes/import.routes";

import express from "express";

const app = express();
console.log("🚀 BOOT APP", new Date().toISOString());

app.use(express.json());
app.use("/items", itemRoutes);
app.use("/import", importRoutes);


app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

export default app;

app.post("/import/items", (_req, res) => {
  res.json({ ok: true, note: "direct route hit" });
});

