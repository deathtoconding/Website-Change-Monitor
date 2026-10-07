import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import argon2 from "argon2";
import { sql } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { Router } from "express";
import type { Response } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  notificationPreferences,
  subscriptions,
  users,
  verificationTokens,
} from "../db/schema.js";
import {
  asyncRoute,
  destroySession,
  regenerateSession,
  requireAuth,
  requireCsrf,
  saveSession,
} from "../middleware.js";
import { logger } from "../logger.js";
import { env } from "../config.js";
import { redisControl } from "../queue.js";
import { createAuthenticationRateLimiters } from "../rate-limits.js";
import {
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "../services/email.js";

export const authRouter = Router();

const { authLimiter, resetLimiter } =
  createAuthenticationRateLimiters(redisControl);

const registerSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((email) => email.toLowerCase()),
  password: z.string().min(12).max(128),
});
const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((email) => email.toLowerCase()),
  password: z.string().min(1).max(128),
});
const tokenSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const sessionCookieName = "wcm.sid";
const passwordHashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;
const registrationMinimumResponseMs = 400;
const dummyPasswordHash = argon2.hash(
  randomBytes(32).toString("hex"),
  passwordHashOptions,
);

// Create a session-bound CSRF token before any unsafe browser request.
authRouter.get("/csrf", (req, res) => {
  req.session.csrfToken ??= randomBytes(32).toString("base64url");
  res.setHeader("Cache-Control", "no-store");
  res.json({ csrfToken: req.session.csrfToken });
});

authRouter.post(
  "/register",
  authLimiter,
  requireCsrf,
  asyncRoute(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          "Enter a valid email address and a password with at least 12 characters.",
      });
      return;
    }
    const { email, password } = parsed.data;
    const passwordError = checkPasswordPolicy(password, email);
    if (passwordError) {
      res.status(400).json({ error: passwordError });
      return;
    }

    const startedAt = Date.now();
    // Run the same password-hashing work before checking whether the address
    // exists, and keep both normal response paths above a common time floor.
    const passwordHash = await argon2.hash(password, passwordHashOptions);
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing) {
      await padRegistrationResponse(startedAt);
      respondToRegistration(res);
      return;
    }

    await createRegisteredAccount(email, passwordHash, req.requestId);
    await padRegistrationResponse(startedAt);
    respondToRegistration(res);
  }),
);

authRouter.post(
  "/login",
  authLimiter,
  requireCsrf,
  asyncRoute(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(401).json({ error: "Invalid email or password." });
      return;
    }
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, parsed.data.email))
      .limit(1);
    const hashToCheck = user?.passwordHash ?? (await dummyPasswordHash);
    const matches = await argon2
      .verify(hashToCheck, parsed.data.password)
      .catch(() => false);
    if (!user || !matches) {
      res.status(401).json({ error: "Invalid email or password." });
      return;
    }
    if (!user.emailVerifiedAt) {
      res.status(403).json({
        error: "Verify your email address before signing in.",
        code: "EMAIL_NOT_VERIFIED",
      });
      return;
    }

    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.sessionVersion = user.sessionVersion;
    req.session.csrfToken = randomBytes(32).toString("base64url");
    await saveSession(req);
    res.json({
      user: { id: user.id, email: user.email, emailVerified: true },
      csrfToken: req.session.csrfToken,
    });
  }),
);

authRouter.get(
  "/me",
  asyncRoute(async (req, res) => {
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
      await destroySession(req);
      res.clearCookie(sessionCookieName, sessionCookieOptions());
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({
      user: {
        id: user.id,
        email: user.email,
        emailVerified: Boolean(user.emailVerifiedAt),
      },
    });
  }),
);

authRouter.post(
  "/logout",
  requireAuth,
  requireCsrf,
  asyncRoute(async (req, res) => {
    await destroySession(req);
    res.clearCookie(sessionCookieName, sessionCookieOptions());
    res.status(204).end();
  }),
);

authRouter.post(
  "/resend-verification",
  resetLimiter,
  requireCsrf,
  asyncRoute(async (req, res) => {
    let developmentVerificationToken: string | undefined;
    const emailResult = z
      .string()
      .trim()
      .email()
      .max(254)
      .safeParse(req.body?.email);
    if (emailResult.success) {
      const [user] = await db
        .select({
          id: users.id,
          email: users.email,
          emailVerifiedAt: users.emailVerifiedAt,
        })
        .from(users)
        .where(eq(users.email, emailResult.data.toLowerCase()))
        .limit(1);
      if (user && !user.emailVerifiedAt) {
        const issued = await db.transaction(async (tx) =>
          issueToken(tx, user.id, "email_verification", 24 * 60 * 60 * 1_000),
        );
        if (env.allowDevVerificationToken)
          developmentVerificationToken = issued.raw;
        await sendVerificationEmail(user.email, issued.raw).catch(() => {
          logger.error(
            {
              requestId: req.requestId,
              userId: user.id,
              errorCode: "VERIFICATION_EMAIL_FAILED",
            },
            "Could not resend verification email",
          );
        });
      }
    }
    res.json({
      message: "If the account needs verification, an email will be sent.",
      ...(developmentVerificationToken ? { developmentVerificationToken } : {}),
    });
  }),
);

authRouter.post(
  "/request-password-reset",
  resetLimiter,
  requireCsrf,
  asyncRoute(async (req, res) => {
    let developmentPasswordResetToken: string | undefined;
    const emailResult = z
      .string()
      .trim()
      .email()
      .max(254)
      .safeParse(req.body?.email);
    if (emailResult.success) {
      const [user] = await db
        .select({
          id: users.id,
          email: users.email,
          emailVerifiedAt: users.emailVerifiedAt,
        })
        .from(users)
        .where(eq(users.email, emailResult.data.toLowerCase()))
        .limit(1);
      if (user?.emailVerifiedAt) {
        const issued = await db.transaction(async (tx) =>
          issueToken(tx, user.id, "password_reset", 30 * 60 * 1_000),
        );
        if (env.allowDevVerificationToken)
          developmentPasswordResetToken = issued.raw;
        await sendPasswordResetEmail(user.email, issued.raw).catch(() => {
          logger.error(
            {
              requestId: req.requestId,
              userId: user.id,
              errorCode: "PASSWORD_RESET_EMAIL_FAILED",
            },
            "Could not send password reset email",
          );
        });
      }
    }
    // Keep this response identical whether or not the account exists.
    res.json({
      message:
        "If an account exists for that email, reset instructions will be sent.",
      ...(developmentPasswordResetToken
        ? { developmentPasswordResetToken }
        : {}),
    });
  }),
);

authRouter.get("/verify-email", (req, res) => {
  const parsedToken = tokenSchema.safeParse(req.query.token);
  if (!parsedToken.success) {
    res
      .status(400)
      .type("html")
      .send(
        simpleAuthPage(
          "Invalid verification link",
          "Request a fresh verification email and try again.",
        ),
      );
    return;
  }
  const token = escapeHtml(parsedToken.data);
  res.setHeader("Cache-Control", "no-store");
  res
    .type("html")
    .send(
      simpleAuthPage(
        "Verify your email",
        "Use the button below to confirm your email address.",
        `<form method="post" action="/api/auth/verify-email"><input type="hidden" name="token" value="${token}"><button type="submit">Verify email address</button></form>`,
      ),
    );
});

authRouter.post(
  "/verify-email",
  asyncRoute(async (req, res) => {
    const parsedToken = tokenSchema.safeParse(req.body?.token);
    if (!parsedToken.success) {
      res
        .status(400)
        .type("html")
        .send(
          simpleAuthPage(
            "Invalid verification link",
            "Request a fresh verification email and try again.",
          ),
        );
      return;
    }
    const verified = await consumeToken(parsedToken.data, "email_verification");
    if (!verified) {
      res
        .status(400)
        .type("html")
        .send(
          simpleAuthPage(
            "Link expired or already used",
            "Sign in if your address is already verified, or request a new verification email.",
          ),
        );
      return;
    }
    res
      .type("html")
      .send(
        simpleAuthPage(
          "Email verified",
          "Your email address is confirmed. You can return to Watchtower and continue.",
          '<p><a href="/">Return to Watchtower</a></p>',
        ),
      );
  }),
);

authRouter.get("/reset-password-form", (req, res) => {
  const parsedToken = tokenSchema.safeParse(req.query.token);
  if (!parsedToken.success) {
    res
      .status(400)
      .type("html")
      .send(
        simpleAuthPage(
          "Invalid reset link",
          "Request a new password reset link and try again.",
        ),
      );
    return;
  }
  const token = escapeHtml(parsedToken.data);
  const form = `<form method="post" action="/api/auth/reset-password"><input type="hidden" name="token" value="${token}"><label>New password <input name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></label><button type="submit">Set new password</button></form>`;
  res.setHeader("Cache-Control", "no-store");
  res
    .type("html")
    .send(
      simpleAuthPage(
        "Choose a new password",
        "Use at least 12 characters and a mix of character types.",
        form,
      ),
    );
});

authRouter.post(
  "/reset-password",
  asyncRoute(async (req, res) => {
    const parsedToken = tokenSchema.safeParse(req.body?.token);
    const parsedPassword = z
      .string()
      .min(12)
      .max(128)
      .safeParse(req.body?.password);
    if (!parsedToken.success || !parsedPassword.success) {
      res
        .status(400)
        .type("html")
        .send(
          simpleAuthPage(
            "Password not accepted",
            "Use a valid reset link and a password with at least 12 characters.",
          ),
        );
      return;
    }
    const passwordError = checkPasswordPolicy(parsedPassword.data);
    if (passwordError) {
      res
        .status(400)
        .type("html")
        .send(simpleAuthPage("Password not accepted", passwordError));
      return;
    }
    const tokenHash = hashToken(parsedToken.data);
    const [token] = await db
      .select({ userId: verificationTokens.userId })
      .from(verificationTokens)
      .where(
        and(
          eq(verificationTokens.tokenHash, tokenHash),
          eq(verificationTokens.purpose, "password_reset"),
          isNull(verificationTokens.consumedAt),
          gt(verificationTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!token) {
      res
        .status(400)
        .type("html")
        .send(
          simpleAuthPage(
            "Link expired or already used",
            "Request a fresh password reset link and try again.",
          ),
        );
      return;
    }

    const passwordHash = await argon2.hash(
      parsedPassword.data,
      passwordHashOptions,
    );
    const updated = await db.transaction(async (tx) => {
      const [lockedToken] = await tx
        .select()
        .from(verificationTokens)
        .where(
          and(
            eq(verificationTokens.tokenHash, tokenHash),
            eq(verificationTokens.purpose, "password_reset"),
            isNull(verificationTokens.consumedAt),
            gt(verificationTokens.expiresAt, new Date()),
          ),
        )
        .for("update")
        .limit(1);
      if (!lockedToken) return false;
      const now = new Date();
      await tx
        .update(verificationTokens)
        .set({ consumedAt: now })
        .where(
          and(
            eq(verificationTokens.userId, lockedToken.userId),
            eq(verificationTokens.purpose, "password_reset"),
            isNull(verificationTokens.consumedAt),
          ),
        );
      await tx
        .update(users)
        .set({
          passwordHash,
          sessionVersion: sql`${users.sessionVersion} + 1`,
          updatedAt: now,
        })
        .where(eq(users.id, lockedToken.userId));
      return true;
    });
    if (!updated) {
      res
        .status(400)
        .type("html")
        .send(
          simpleAuthPage(
            "Link expired or already used",
            "Request a fresh password reset link and try again.",
          ),
        );
      return;
    }
    res
      .type("html")
      .send(
        simpleAuthPage(
          "Password updated",
          "Your password has been changed. Other signed-in sessions have been invalidated.",
          '<p><a href="/">Return to sign in</a></p>',
        ),
      );
  }),
);

type DatabaseTransaction = NodePgTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

async function issueToken(
  tx: DatabaseTransaction,
  userId: string,
  purpose: "email_verification" | "password_reset",
  ttlMs: number,
) {
  const now = new Date();
  await tx
    .update(verificationTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(verificationTokens.userId, userId),
        eq(verificationTokens.purpose, purpose),
        isNull(verificationTokens.consumedAt),
      ),
    );
  const raw = randomBytes(32).toString("base64url");
  await tx.insert(verificationTokens).values({
    userId,
    purpose,
    tokenHash: hashToken(raw),
    expiresAt: new Date(now.getTime() + ttlMs),
  });
  return { raw };
}

async function consumeToken(
  raw: string,
  purpose: "email_verification" | "password_reset",
): Promise<boolean> {
  const hash = hashToken(raw);
  return db.transaction(async (tx) => {
    const [token] = await tx
      .select()
      .from(verificationTokens)
      .where(
        and(
          eq(verificationTokens.tokenHash, hash),
          eq(verificationTokens.purpose, purpose),
          isNull(verificationTokens.consumedAt),
          gt(verificationTokens.expiresAt, new Date()),
        ),
      )
      .for("update")
      .limit(1);
    if (!token) return false;
    const now = new Date();
    await tx
      .update(verificationTokens)
      .set({ consumedAt: now })
      .where(eq(verificationTokens.id, token.id));
    if (purpose === "email_verification") {
      await tx
        .update(users)
        .set({ emailVerifiedAt: now, updatedAt: now })
        .where(eq(users.id, token.userId));
    }
    return true;
  });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function checkPasswordPolicy(password: string, email?: string): string | null {
  if (password.length < 12) return "Use at least 12 characters.";
  if (password.length > 128) return "Use 128 characters or fewer.";
  const classes = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^a-zA-Z0-9]/.test(password),
  ].filter(Boolean).length;
  if (classes < 3)
    return "Include at least three of: lowercase, uppercase, number, or symbol.";
  const localPart = email?.split("@")[0]?.toLowerCase();
  if (
    localPart &&
    localPart.length >= 4 &&
    password.toLowerCase().includes(localPart)
  )
    return "Do not include your email name in your password.";
  if (/^(password|qwerty|letmein|welcome|123456|admin)/i.test(password))
    return "Choose a less common password.";
  return null;
}

async function padRegistrationResponse(startedAt: number): Promise<void> {
  const remaining = registrationMinimumResponseMs - (Date.now() - startedAt);
  if (remaining > 0) await delay(remaining);
}

async function createRegisteredAccount(
  email: string,
  passwordHash: string,
  requestId: string | undefined,
): Promise<void> {
  try {
    const created = await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ email, passwordHash })
        .returning({ id: users.id });
      await tx.insert(notificationPreferences).values({ userId: user.id });
      await tx
        .insert(subscriptions)
        .values({ userId: user.id, plan: "free", status: "active" });
      const token = await issueToken(
        tx,
        user.id,
        "email_verification",
        24 * 60 * 60 * 1_000,
      );
      return { user, token };
    });

    void sendVerificationEmail(email, created.token.raw).catch(() => {
      logger.error(
        {
          requestId,
          userId: created.user.id,
          errorCode: "VERIFICATION_EMAIL_FAILED",
        },
        "Could not send verification email",
      );
    });
  } catch (error) {
    // Concurrent requests for the same address race after the initial lookup;
    // the unique index picks one winner and all callers retain the same reply.
    if (isUniqueViolation(error)) return;
    logger.error(
      {
        requestId,
        errorCode: "REGISTRATION_PERSIST_FAILED",
      },
      "Could not persist registration; the user may retry",
    );
  }
}

function respondToRegistration(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.status(202).json({
    message:
      "If the address can be registered, check your email for next steps. If you already have an account, sign in or request a password reset.",
  });
}

function sessionCookieOptions() {
  return {
    path: "/",
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "lax" as const,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );
}

function simpleAuthPage(
  title: string,
  description: string,
  content = "",
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Watchtower</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f8f5;color:#24352a;font:15px system-ui,sans-serif}.card{width:min(440px,calc(100% - 40px));padding:28px;border:1px solid #e2eae3;border-radius:14px;background:#fff;box-shadow:0 12px 40px #18362212}h1{margin:0 0 8px;font-size:22px}p{color:#68766d;line-height:1.6;font-size:13px}form{display:grid;gap:12px;margin-top:20px}label{display:grid;gap:7px;color:#516158;font-size:12px}input{height:38px;padding:0 10px;border:1px solid #dfe7e1;border-radius:7px;font:inherit}button{min-height:40px;padding:0 14px;border:0;border-radius:7px;background:#267e58;color:#fff;font:700 13px system-ui,sans-serif;cursor:pointer}a{color:#267e58}</style></head><body><main class="card"><div style="color:#448260;font-size:10px;font-weight:700;letter-spacing:1px;margin-bottom:13px">WATCHTOWER</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p>${content}</main></body></html>`;
}
