import { Request, Response } from "express";
import { createUser, loginUser } from "./auth.service";
import jwt from "jsonwebtoken";
import prisma from "../prisma/client";

const JWT_SECRET = "dev-secret";

export async function register(req: Request, res: Response) {
  const { email, password } = req.body;

  try {
    const user = await createUser(email, password);

    const token = jwt.sign({ userId: user.id }, JWT_SECRET);

    res.json({
      id: user.id,
      email: user.email,
      token
    });
  } catch {
    res.status(400).json({ message: "User already exists" });
  }
}

export async function login(req: Request, res: Response) {
  const { email, password } = req.body;

  const user = await loginUser(email, password);

  if (!user) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET);

  res.json({
    id: user.id,
    email: user.email,
    token
  });
}

export async function logout(_req: Request, res: Response) {
  res.json({ ok: true });
}

export async function me(req: Request, res: Response) {
  if (!req.user?.id) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.id }
  });

  return res.json({
    id: user?.id,
    email: user?.email,
    plan: user?.plan ?? "free",
    premiumSince: user?.premiumSince
  });
}

/**
 * 🔥 SOLO PARA TESTING (luego lo quitamos)
 */
export async function upgradeToPremium(req: Request, res: Response) {
  if (!req.user?.id) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.id }
  });

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      plan: "premium",
      premiumSince: user.premiumSince ?? new Date()
    }
  });

  res.json(updated);
}