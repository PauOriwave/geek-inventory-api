import { Request, Response, NextFunction } from "express";

type Plan = "free" | "premium" | "market_pro";

function getPlanLevel(plan: Plan) {
  if (plan === "market_pro") return 3;
  if (plan === "premium") return 2;
  return 1;
}

export function requirePlan(minPlan: Plan) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const userPlan = (user.plan || "free") as Plan;

    if (getPlanLevel(userPlan) < getPlanLevel(minPlan)) {
      return res.status(403).json({
        message: "Upgrade required",
        requiredPlan: minPlan
      });
    }

    next();
  };
}