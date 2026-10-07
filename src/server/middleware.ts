import { timingSafeEqual, randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { users } from "./db/schema.js";
import { env } from "./config.js";

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const incoming = req.header("x-request-id");
  const requestId =
    incoming && /^[a-zA-Z0-9._-]{1,80}$/.test(incoming)
      ? incoming
      : randomUUID();
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  next();
}

export function requireCsrf(req: Request, res: Response, next: NextFunction) {
  const origin = req.get("origin");
  if (origin) {
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      res.status(403).json({ error: "Invalid request origin." });
      return;
    }
    const normalizedOrigin = originUrl.origin;
    const requestHost = (req.get("x-forwarded-host") ?? req.get("host") ?? "")
      .split(",")[0]
      .trim()
      .toLowerCase();
    const sameDevHost =
      env.nodeEnv === "development" &&
      originUrl.host.toLowerCase() === requestHost;
    if (normalizedOrigin !== env.appOrigin && !sameDevHost) {
      res.status(403).json({ error: "Cross-origin requests are not allowed." });
      return;
    }
  }

  const expected = req.session?.csrfToken;
  const submitted = req.get("x-csrf-token");
  if (!expected || !submitted) {
    res.status(403).json({ error: "A valid CSRF token is required." });
    return;
  }
  const expectedBytes = Buffer.from(expected);
  const submittedBytes = Buffer.from(submitted);
  if (
    expectedBytes.length !== submittedBytes.length ||
    !timingSafeEqual(expectedBytes, submittedBytes)
  ) {
    res.status(403).json({ error: "A valid CSRF token is required." });
    return;
  }
  next();
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const userId = req.session.userId;
  const sessionVersion = req.session.sessionVersion;
  if (!userId || typeof sessionVersion !== "number") {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user || user.sessionVersion !== sessionVersion) {
    req.session.destroy(() => undefined);
    res.clearCookie("wcm.sid");
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  if (!user.emailVerifiedAt) {
    res.status(403).json({
      error: "Verify your email address before continuing.",
      code: "EMAIL_NOT_VERIFIED",
    });
    return;
  }

  req.authUser = user;
  next();
}

export function asyncRoute(
  handler: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });
}

export function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

export function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => (error ? reject(error) : resolve()));
  });
}
