import prisma from "../prisma/client";
import bcrypt from "bcrypt";

export async function createUser(email: string, password: string) {
  const passwordHash = await bcrypt.hash(password, 10);

  return prisma.user.create({
    data: {
      email,
      passwordHash
    }
  });
}

export async function loginUser(email: string, password: string) {
  const user = await prisma.user.findUnique({
    where: { email }
  });

  if (!user) return null;

  const valid = await bcrypt.compare(password, user.passwordHash);

  if (!valid) return null;

  return user;
}