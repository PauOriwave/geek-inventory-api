import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = "dev-secret";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        plan?: string;
      };
    }
  }
}

type JwtPayload = {
  userId: string;
  plan?: string;
};

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  const tokenFromHeader = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  const tokenFromCookie =
    typeof req.headers.cookie === "string"
      ? req.headers.cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("session="))
          ?.slice("session=".length) ?? null
      : null;

  const token = tokenFromHeader || tokenFromCookie;

  if (!token) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;

    req.user = {
      id: payload.userId,
      plan: payload.plan ?? "free"
    };

    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
}