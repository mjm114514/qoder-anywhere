export const config = {
  port: parseInt(process.env.PORT ?? "3001", 10),
  idleTimeoutMs: 5 * 60 * 1000, // 5 minutes
  recycleIntervalMs: 60 * 1000, // check every minute
};
