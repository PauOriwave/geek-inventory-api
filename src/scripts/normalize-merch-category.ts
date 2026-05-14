import prisma from "../prisma/client";

async function main() {
  const updatedItems = await prisma.item.updateMany({
    where: {
      category: "other"
    },
    data: {
      category: "merch"
    }
  });

  const updatedWishlistItems = await prisma.wishlistItem.updateMany({
    where: {
      category: "other"
    },
    data: {
      category: "merch"
    }
  });

  console.log("Updated items:", updatedItems.count);
  console.log("Updated wishlist items:", updatedWishlistItems.count);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });