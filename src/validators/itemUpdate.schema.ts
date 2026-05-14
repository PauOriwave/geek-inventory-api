import { z } from "zod";

export const updateItemSchema = z.object({
  name: z.string().min(1).optional(),
  category: z.enum(["videogame", "book", "comic", "tcg", "figure", "merch"]).optional(),
  estimatedPrice: z.number().positive().optional(),
  quantity: z.number().int().positive().optional(),
}).strict();