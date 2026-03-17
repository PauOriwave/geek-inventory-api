import { Request, Response } from "express";
import { createUser, loginUser } from "./auth.service";
import jwt from "jsonwebtoken";

const JWT_SECRET = "dev-secret";

export async function register(req: Request, res: Response) {
  const { email, password } = req.body;

  try {
    const user = await createUser(email, password);

    const token = jwt.sign({ userId: user.id }, JWT_SECRET);

    res.cookie("session", token, {
      httpOnly: true
    });

    res.json({
      id: user.id,
      email: user.email
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

  res.cookie("session", token, {
    httpOnly: true
  });

  res.json({
    id: user.id,
    email: user.email
  });
}

export async function logout(_req: Request, res: Response) {
  res.clearCookie("session");
  res.json({ ok: true });
}