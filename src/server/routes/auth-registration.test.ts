import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existingUser: false,
  uniqueViolation: false,
  db: {
    select: vi.fn(),
    transaction: vi.fn(),
  },
  sendVerificationEmail: vi.fn(),
  argon2Hash: vi.fn(),
  servers: new Set<Server>(),
}));

vi.mock("argon2", () => ({
  default: {
    argon2id: 2,
    hash: (...args: unknown[]) => mocks.argon2Hash(...args),
    verify: vi.fn(),
  },
}));

vi.mock("../db/index.js", () => ({ db: mocks.db }));

vi.mock("../middleware.js", () => ({
  asyncRoute:
    (
      handler: (req: unknown, res: unknown, next: unknown) => Promise<unknown>,
    ) =>
    (req: unknown, res: unknown, next: (error?: unknown) => void) => {
      void handler(req, res, next).catch(next);
    },
  destroySession: vi.fn(),
  regenerateSession: vi.fn(),
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireCsrf: (_req: unknown, _res: unknown, next: () => void) => next(),
  saveSession: vi.fn(),
}));

vi.mock("../queue.js", () => ({ redisControl: { call: vi.fn() } }));
vi.mock("../rate-limits.js", () => ({
  createAuthenticationRateLimiters: () => ({
    authLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
    resetLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));
vi.mock("../services/email.js", () => ({
  sendPasswordResetEmail: vi.fn(),
  sendVerificationEmail: (...args: unknown[]) =>
    mocks.sendVerificationEmail(...args),
}));
vi.mock("../logger.js", () => ({ logger: { error: vi.fn() } }));

import { authRouter } from "./auth.js";

const password = "Clear!Password934";

beforeEach(() => {
  mocks.existingUser = false;
  mocks.uniqueViolation = false;
  mocks.db.select.mockReset();
  mocks.db.transaction.mockReset();
  mocks.sendVerificationEmail.mockReset().mockResolvedValue(undefined);
  mocks.argon2Hash.mockReset().mockResolvedValue("argon2-hash");

  mocks.db.select.mockImplementation(() => {
    const query = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi
        .fn()
        .mockResolvedValue(mocks.existingUser ? [{ id: "existing-user" }] : []),
    };
    return query;
  });

  mocks.db.transaction.mockImplementation(async (callback) => {
    if (mocks.uniqueViolation) {
      throw Object.assign(new Error("duplicate email"), { code: "23505" });
    }
    const tx = {
      insert: vi.fn(() => ({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: "new-user" }]),
      })),
      update: vi.fn(() => ({
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(undefined),
      })),
    };
    return callback(tx);
  });
});

afterEach(async () => {
  await Promise.all(
    [...mocks.servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  mocks.servers.clear();
});

describe("registration account-enumeration protection", () => {
  it("returns the same status and body for existing and new addresses", async () => {
    const server = await startAuthServer();

    mocks.existingUser = true;
    const existingResponse = await register(server, "person@example.test");
    mocks.existingUser = false;
    const newResponse = await register(server, "new-person@example.test");

    expect(existingResponse.status).toBe(202);
    expect(newResponse.status).toBe(202);
    expect(existingResponse.body).toEqual(newResponse.body);
    expect(existingResponse.body).toEqual({
      message:
        "If the address can be registered, check your email for next steps. If you already have an account, sign in or request a password reset.",
    });
    expect(existingResponse.headers.get("set-cookie")).toBeNull();
    expect(newResponse.headers.get("set-cookie")).toBeNull();
    await vi.waitFor(() =>
      expect(mocks.sendVerificationEmail).toHaveBeenCalledTimes(1),
    );
    expect(mocks.sendVerificationEmail).toHaveBeenCalledWith(
      "new-person@example.test",
      expect.any(String),
    );
    expect(mocks.argon2Hash).toHaveBeenCalledTimes(2);
  });

  it("keeps the response generic when new-account persistence fails", async () => {
    const server = await startAuthServer();
    mocks.db.transaction.mockRejectedValue(new Error("database write failed"));

    const response = await register(server, "retry-later@example.test");

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      message:
        "If the address can be registered, check your email for next steps. If you already have an account, sign in or request a password reset.",
    });
    expect(mocks.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("keeps the unique-constraint race response generic", async () => {
    const server = await startAuthServer();
    mocks.uniqueViolation = true;

    const response = await register(server, "race@example.test");

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      message:
        "If the address can be registered, check your email for next steps. If you already have an account, sign in or request a password reset.",
    });
    expect(mocks.sendVerificationEmail).not.toHaveBeenCalled();
  });
});

async function startAuthServer(): Promise<Server> {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  app.use(
    (_error: unknown, _req: unknown, res: express.Response, _next: unknown) => {
      void _next;
      res.status(500).json({ error: "unexpected" });
    },
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  mocks.servers.add(server);
  return server;
}

async function register(server: Server, email: string) {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Server not ready");
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/auth/register`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    },
  );
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}
