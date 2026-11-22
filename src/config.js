import "dotenv/config";

export const config = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || "development",
  databaseUrl: process.env.DATABASE_URL || "postgres://knet:knet@localhost:5433/knet",
  corsOrigin: (process.env.CORS_ORIGIN || "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean),
  demoUserEmail: process.env.DEMO_USER_EMAIL || "demo.tech@knet.local",
};
