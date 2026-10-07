import { createServer } from "node:http";
import express from "express";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthenticationRateLimiters } from "./rate-limits.js";

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
});

describe("Redis-backed authentication rate limits", () => {
  it("fails closed with a server error when Redis is unavailable", async () => {
    const evalCommand = vi
      .fn()
      .mockRejectedValue(new Error("Redis unavailable"));
    const { authLimiter } = createAuthenticationRateLimiters(
      { eval: evalCommand } as unknown as Pick<Redis, "eval">,
      "fail-closed-test",
    );
    const app = express();
    app.post("/auth", authLimiter, (_req, res) => res.sendStatus(204));
    app.use(
      (
        _error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        void _next;
        res.sendStatus(503);
      },
    );

    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    servers.add(server);
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Rate-limit test server did not start.");

    const response = await fetch(`http://127.0.0.1:${address.port}/auth`, {
      method: "POST",
    });

    expect(response.status).toBe(503);
    expect(evalCommand).toHaveBeenCalledTimes(1);
  });
});
