import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { RequestOptions } from "node:http";
import { env } from "../config.js";
import { logger } from "../logger.js";
import {
  assertSafeHttpUrl,
  normalizeHttpUrl,
  UrlSafetyError,
  type AddressRecord,
  type Resolver,
} from "../security/url-safety.js";

export interface FetchResult {
  url: string;
  html: string;
  httpStatus: number;
  contentType: string;
  responseTimeMs: number;
  fetchedAt: Date;
}

export class FetchError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "FetchError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  responseTimeMs: number;
  redirectLocation?: string;
}

export interface FetchDependencies {
  resolver?: Resolver;
  request?: (url: URL, address: AddressRecord) => Promise<RawResponse>;
  beforeRequest?: (url: URL) => Promise<void>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Fetch a page only after validating and pinning every DNS resolution, including redirects. */
export async function fetchPage(
  input: string,
  dependencies: FetchDependencies = {},
): Promise<FetchResult> {
  let url = normalizeHttpUrl(input);
  const request = dependencies.request ?? requestOnce;
  for (let redirects = 0; redirects <= env.fetchMaxRedirects; redirects += 1) {
    const { url: safeUrl, addresses } = await assertSafeHttpUrl(
      url.toString(),
      dependencies.resolver,
    );
    url = safeUrl;
    await dependencies.beforeRequest?.(url);
    const raw = await request(url, addresses[0]);

    if (REDIRECT_STATUSES.has(raw.status)) {
      if (!raw.redirectLocation)
        throw new FetchError(
          "REDIRECT_WITHOUT_LOCATION",
          "The website returned a redirect without a destination.",
          false,
        );
      if (redirects === env.fetchMaxRedirects)
        throw new FetchError(
          "TOO_MANY_REDIRECTS",
          "The website redirected too many times.",
          false,
        );
      try {
        // The next loop re-parses the destination and re-resolves its DNS before connecting.
        url = new URL(raw.redirectLocation, url);
      } catch {
        throw new FetchError(
          "INVALID_REDIRECT",
          "The website returned an invalid redirect destination.",
          false,
        );
      }
      continue;
    }

    if (raw.status < 200 || raw.status >= 300) {
      const retryable = TRANSIENT_STATUSES.has(raw.status) || raw.status >= 500;
      throw new FetchError(
        `HTTP_${raw.status}`,
        `The website returned HTTP ${raw.status}.`,
        retryable,
      );
    }

    const contentType =
      firstHeader(raw.headers["content-type"])
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() ?? "";
    if (
      !["text/html", "application/xhtml+xml", "text/plain"].includes(
        contentType,
      )
    ) {
      throw new FetchError(
        "UNSUPPORTED_CONTENT_TYPE",
        "The response is not an HTML or plain-text page.",
        false,
      );
    }

    return {
      url: url.toString(),
      html: raw.body.toString("utf8"),
      httpStatus: raw.status,
      contentType,
      responseTimeMs: raw.responseTimeMs,
      fetchedAt: new Date(),
    };
  }
  throw new FetchError(
    "TOO_MANY_REDIRECTS",
    "The website redirected too many times.",
    false,
  );
}

async function requestOnce(
  url: URL,
  address: { address: string; family: number },
): Promise<RawResponse> {
  const parsedHostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(parsedHostname) && parsedHostname !== address.address) {
    throw new UrlSafetyError(
      "The resolved address did not match the requested IP literal.",
    );
  }
  const lookup = pinnedLookup(address.address, address.family);
  const client = url.protocol === "https:" ? https : http;
  const startedAt = performance.now();

  return new Promise<RawResponse>((resolve, reject) => {
    let finished = false;
    const timeout: { handle?: NodeJS.Timeout } = {};
    const finishReject = (error: Error) => {
      if (finished) return;
      finished = true;
      if (timeout.handle) clearTimeout(timeout.handle);
      reject(error);
    };
    const finishResolve = (response: RawResponse) => {
      if (finished) return;
      finished = true;
      if (timeout.handle) clearTimeout(timeout.handle);
      resolve(response);
    };

    const request = client.request(
      {
        protocol: url.protocol,
        hostname: parsedHostname,
        port: url.port
          ? Number(url.port)
          : url.protocol === "https:"
            ? 443
            : 80,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        headers: {
          "user-agent":
            "WebsiteChangeMonitor/1.0 (automated public-page change monitoring)",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.1",
          "accept-encoding": "identity",
          host: url.host,
          connection: "close",
        },
        lookup,
        servername: isIP(parsedHostname) ? undefined : parsedHostname,
        rejectUnauthorized: true,
        agent: false,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (REDIRECT_STATUSES.has(status)) {
          const redirectLocation = firstHeader(response.headers.location);
          response.destroy();
          finishResolve({
            status,
            headers: response.headers,
            body: Buffer.alloc(0),
            responseTimeMs: Math.round(performance.now() - startedAt),
            redirectLocation,
          });
          return;
        }

        const contentEncoding = firstHeader(
          response.headers["content-encoding"],
        )
          ?.trim()
          .toLowerCase();
        if (contentEncoding && contentEncoding !== "identity") {
          response.destroy();
          finishReject(
            new FetchError(
              "UNSUPPORTED_CONTENT_ENCODING",
              "The website returned an unsupported compressed response.",
              false,
            ),
          );
          return;
        }

        const declaredLength = Number(
          firstHeader(response.headers["content-length"]),
        );
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > env.maxFetchBytes
        ) {
          response.destroy(
            new FetchError(
              "RESPONSE_TOO_LARGE",
              "The page exceeds the maximum response size.",
              false,
            ),
          );
          finishReject(
            new FetchError(
              "RESPONSE_TOO_LARGE",
              "The page exceeds the maximum response size.",
              false,
            ),
          );
          return;
        }

        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += buffer.byteLength;
          if (receivedBytes > env.maxFetchBytes) {
            response.destroy(
              new FetchError(
                "RESPONSE_TOO_LARGE",
                "The page exceeds the maximum response size.",
                false,
              ),
            );
            finishReject(
              new FetchError(
                "RESPONSE_TOO_LARGE",
                "The page exceeds the maximum response size.",
                false,
              ),
            );
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () =>
          finishResolve({
            status,
            headers: response.headers,
            body: Buffer.concat(chunks, receivedBytes),
            responseTimeMs: Math.round(performance.now() - startedAt),
          }),
        );
        response.on("error", (error) => finishReject(mapNetworkError(error)));
      },
    );

    request.on("error", (error) => finishReject(mapNetworkError(error)));
    timeout.handle = setTimeout(() => {
      request.destroy(
        new FetchError(
          "FETCH_TIMEOUT",
          "The website did not respond before the timeout.",
          true,
        ),
      );
    }, env.fetchTimeoutMs);
    timeout.handle.unref();
    request.end();
  });
}

type PinnedLookup = NonNullable<RequestOptions["lookup"]>;

function pinnedLookup(address: string, family: number): PinnedLookup {
  return (_hostname, options, callback) => {
    if (
      options &&
      typeof options === "object" &&
      "all" in options &&
      options.all
    ) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

function mapNetworkError(error: Error): Error {
  if (error instanceof FetchError || error instanceof UrlSafetyError)
    return error;
  const code =
    "code" in error && typeof error.code === "string"
      ? error.code
      : "NETWORK_ERROR";
  const retryable = [
    "ECONNRESET",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "ENOTFOUND",
    "ETIMEDOUT",
    "EPIPE",
  ].includes(code);
  logger.debug({ errorCode: code }, "Website request failed");
  return new FetchError(
    code,
    retryable
      ? "The website could not be reached temporarily."
      : "The website request failed.",
    retryable,
  );
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
