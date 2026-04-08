import { Request, Response, NextFunction } from "express";

export function requirePremium(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (req.user?.plan !== "premium") {
    return res.status(403).json({
      message: "Premium required"
    });
  }

  next();
}