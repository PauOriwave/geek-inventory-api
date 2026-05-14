import { z } from "zod";

export const itemSchema = z
  .object({
    name: z.string().min(1),
    category: z.enum([
      "videogame",
      "book",
      "comic",
      "tcg",
      "figure",
      "boardgame",
      "miniature",
      "lego",
      "movie",
      "merch"
    ]),
    estimatedPrice: z.number().positive(),
    quantity: z.number().int().positive()
  })
  .strict();