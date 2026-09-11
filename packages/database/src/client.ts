import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { bugwrightPrisma?: PrismaClient };
export const db = globalForPrisma.bugwrightPrisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.bugwrightPrisma = db;
