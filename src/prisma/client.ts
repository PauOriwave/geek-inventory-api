import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is missing in .env");
}

// Pool de Postgres (conexiones reutilizables)
const pool = new Pool({ connectionString });

// Adapter que Prisma 7 necesita
const adapter = new PrismaPg(pool);

// PrismaClient con adapter (Prisma 7)
const prisma = new PrismaClient({ adapter });

export default prisma;
