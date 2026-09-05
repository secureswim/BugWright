import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { bugpilotPrisma?: PrismaClient };
export const db = globalForPrisma.bugpilotPrisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.bugpilotPrisma = db;
export * from "@prisma/client";
