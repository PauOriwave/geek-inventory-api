-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "lastValuationAt" TIMESTAMP(3),
ADD COLUMN     "marketValue" DECIMAL(65,30),
ADD COLUMN     "valuationConfidence" DOUBLE PRECISION,
ADD COLUMN     "valuationSource" TEXT;

-- CreateTable
CREATE TABLE "ItemValuationSnapshot" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "marketValue" DECIMAL(65,30) NOT NULL,
    "confidence" DOUBLE PRECISION,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemValuationSnapshot_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ItemValuationSnapshot" ADD CONSTRAINT "ItemValuationSnapshot_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
