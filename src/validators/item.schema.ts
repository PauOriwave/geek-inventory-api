import { z } from "zod";

export const createItemSchema = z.object({
  name: z.string().min(1),
  category: z.enum(["videogame", "book", "comic", "tcg", "figure", "other"]),
  estimatedPrice: z.number().nonnegative(),
  quantity: z.number().int().positive().default(1)
});
