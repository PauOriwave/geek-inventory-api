import { Request, Response } from "express";
import { getPublicProfileByUserIdService } from "../services/users.service";

export async function getPublicProfileByUserId(
  req: Request,
  res: Response
) {
  try {
    const userId = String(req.params.id);

    const data = await getPublicProfileByUserIdService(userId);

    if (!data) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json(data);
  } catch (error) {
    console.error("getPublicProfileByUserId error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}