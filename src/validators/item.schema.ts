import { z } from "zod";

const categorySchema = z
  .enum([
    "videogame",
    "book",
    "comic",
    "tcg",
    "figure",
    "boardgame",
    "miniature",
    "lego",
    "movie",
    "merch",
    "other"
  ])
  .transform((category) => (category === "other" ? "merch" : category));

export const itemSchema = z
  .object({
    name: z.string().min(1),
    category: categorySchema,
    estimatedPrice: z.number().positive(),
    quantity: z.number().int().positive()
  })
  .strict();