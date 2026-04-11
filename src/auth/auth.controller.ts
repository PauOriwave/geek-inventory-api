import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import prisma from "../prisma/client";
import { createUser, loginUser } from "./auth.service";

const JWT_SECRET = "dev-secret";

function buildToken(userId: string) {
  return jwt.sign({ userId }, JWT_SECRET, {
    expiresIn: "30d"
  });
}

function setSessionCookie(res: Response, token: string) {
  res.cookie("session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 30
  });
}

export async function register(req: Request, res: Response) {
  const { email, password } = req.body;

  try {
    const user = await createUser(email, password);
    const token = buildToken(user.id);

    setSessionCookie(res, token);

    return res.json({
      id: user.id,
      email: user.email,
      plan: user.plan ?? "free",
      premiumStartedAt: user.premiumStartedAt,
      token
    });
  } catch {
    return res.status(400).json({ message: "User already exists" });
  }
}

export async function login(req: Request, res: Response) {
  const { email, password } = req.body;

  const user = await loginUser(email, password);

  if (!user) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  const token = buildToken(user.id);

  setSessionCookie(res, token);

  return res.json({
    id: user.id,
    email: user.email,
    plan: user.plan ?? "free",
    premiumStartedAt: user.premiumStartedAt,
    token
  });
}

export async function logout(_req: Request, res: Response) {
  res.clearCookie("session", {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/"
  });

  return res.json({ ok: true });
}

export async function me(req: Request, res: Response) {
  if (!req.user?.id) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.id }
  });

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  return res.json({
    id: user.id,
    email: user.email,
    plan: user.plan ?? "free",
    premiumStartedAt: user.premiumStartedAt
  });
}

/**
 * SOLO PARA TESTING
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
      premiumStartedAt: user.premiumStartedAt ?? new Date()
    }
  });

  return res.json(updated);
}

/**
 * SOLO PARA TESTING
 */
export async function upgradeToMarketPro(req: Request, res: Response) {
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
      plan: "market_pro",
      premiumStartedAt: user.premiumStartedAt ?? new Date()
    }
  });

  return res.json(updated);
}