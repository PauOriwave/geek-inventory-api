import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = "dev-secret";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const cookieToken = req.cookies?.session;

  const authHeader = req.headers.authorization;
  const bearerToken =
    authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : undefined;

  const token = cookieToken || bearerToken;

  if (!token) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: string };

    req.user = {
      id: payload.userId
    };

    next();
  } catch {
    return res.status(401).json({ message: "Invalid session" });
  }
}