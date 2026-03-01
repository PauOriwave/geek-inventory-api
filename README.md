# Geek Inventory API

Backend API to manage and value a personal collection (videogames, books, comics, TCG, figures, etc).
Supports bulk import via CSV.

## Tech
- Node.js + TypeScript
- Express
- PostgreSQL
- Prisma ORM
- Zod validation
- Multer + CSV parse (CSV import)

## Features
- Create items
- List items
- Bulk import items from CSV (`POST /import/items`)

## Setup
1) Install dependencies
```bash
pnpm install
