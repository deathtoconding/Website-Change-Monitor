import type { User } from "./db/schema.js";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    sessionVersion?: number;
    csrfToken?: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      authUser?: User;
      requestId?: string;
    }
  }
}

export {};
