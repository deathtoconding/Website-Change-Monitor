import rateLimit, {
  type IncrementResponse,
  type RateLimitRequestHandler,
  type Store,
} from "express-rate-limit";
import type { Redis } from "ioredis";

const AUTH_WINDOW_MS = 15 * 60 * 1_000;
const RESET_WINDOW_MS = 60 * 60 * 1_000;
const AUTH_LIMIT = 10;
const RESET_LIMIT = 5;

const INCREMENT_SCRIPT = `
local totalHits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if totalHits == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { totalHits, ttl }
`;

const GET_SCRIPT = `
local totalHits = redis.call('GET', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
return { totalHits or false, ttl }
`;

const DECREMENT_SCRIPT = `
local totalHits = redis.call('DECR', KEYS[1])
if totalHits <= 0 then
  redis.call('DEL', KEYS[1])
  return 0
end
return totalHits
`;

const RESET_SCRIPT = "return redis.call('DEL', KEYS[1])";

export interface AuthenticationRateLimiters {
  authLimiter: RateLimitRequestHandler;
  resetLimiter: RateLimitRequestHandler;
}

/** Build independent Redis-backed stores with atomic counters shared across processes. */
export function createAuthenticationRateLimiters(
  redis: Pick<Redis, "eval">,
  namespace = "wcm",
): AuthenticationRateLimiters {
  return {
    authLimiter: rateLimit({
      windowMs: AUTH_WINDOW_MS,
      limit: AUTH_LIMIT,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many attempts. Please try again later." },
      store: new RedisRateLimitStore(
        redis,
        `wcm:rate-limit:${namespace}:auth:`,
      ),
      // Auth attempts fail closed (HTTP 5xx through the API error handler) if
      // the shared store is unreachable; there is no process-local fallback.
      passOnStoreError: false,
    }),
    resetLimiter: rateLimit({
      windowMs: RESET_WINDOW_MS,
      limit: RESET_LIMIT,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many attempts. Please try again later." },
      store: new RedisRateLimitStore(
        redis,
        `wcm:rate-limit:${namespace}:reset:`,
      ),
      passOnStoreError: false,
    }),
  };
}

class RedisRateLimitStore implements Store {
  private windowMs = 0;

  constructor(
    private readonly redis: Pick<Redis, "eval">,
    readonly prefix: string,
  ) {}

  init(options: { windowMs: number }): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const reply = await this.redis.eval(
      INCREMENT_SCRIPT,
      1,
      this.key(key),
      String(this.windowMs),
    );
    const [totalHits, ttl] = parseCounterReply(reply);
    if (totalHits < 1 || ttl < 0)
      throw new Error("Redis returned an invalid rate-limit counter.");
    return { totalHits, resetTime: new Date(Date.now() + ttl) };
  }

  async get(key: string): Promise<IncrementResponse> {
    const reply = await this.redis.eval(GET_SCRIPT, 1, this.key(key));
    const [totalHits, ttl] = parseCounterReply(reply);
    return {
      totalHits,
      resetTime: ttl >= 0 ? new Date(Date.now() + ttl) : undefined,
    };
  }

  async decrement(key: string): Promise<void> {
    await this.redis.eval(DECREMENT_SCRIPT, 1, this.key(key));
  }

  async resetKey(key: string): Promise<void> {
    await this.redis.eval(RESET_SCRIPT, 1, this.key(key));
  }

  private key(key: string): string {
    return `${this.prefix}${key}`;
  }
}

function parseCounterReply(reply: unknown): [number, number] {
  if (!Array.isArray(reply) || reply.length !== 2)
    throw new Error("Redis returned an invalid rate-limit counter response.");

  const hitsValue = reply[0];
  const ttlValue = reply[1];
  const totalHits =
    hitsValue === false || hitsValue === null ? 0 : Number(hitsValue);
  const ttl = Number(ttlValue);
  if (
    !Number.isSafeInteger(totalHits) ||
    totalHits < 0 ||
    !Number.isFinite(ttl)
  ) {
    throw new Error("Redis returned an invalid rate-limit counter response.");
  }
  return [totalHits, ttl];
}
