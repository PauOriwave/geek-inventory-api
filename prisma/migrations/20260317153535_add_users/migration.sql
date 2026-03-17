/*
  Warnings:

  - Added the required column `userId` to the `Item` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `category` on the `Item` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "userId" TEXT NOT NULL,
DROP COLUMN "category",
ADD COLUMN     "category" TEXT NOT NULL,
ALTER COLUMN "quantity" DROP DEFAULT;

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
