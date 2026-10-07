import { describe, expect, it } from "vitest";
import { UrlSafetyError } from "../security/url-safety.js";
import { FetchError, fetchPage, type RawResponse } from "./http-fetcher.js";

const publicResolver = async (hostname: string) => {
  if (hostname === "www.example.com")
    return [{ address: "93.184.216.34", family: 4 }];
  if (hostname === "cdn.example.org")
    return [{ address: "93.184.216.35", family: 4 }];
  return [{ address: "127.0.0.1", family: 4 }];
};

function response(
  status: number,
  options: { location?: string; html?: string } = {},
): RawResponse {
  return {
    status,
    headers: options.location
      ? { location: options.location }
      : { "content-type": "text/html; charset=utf-8" },
    body: Buffer.from(options.html ?? "", "utf8"),
    responseTimeMs: 4,
    ...(options.location ? { redirectLocation: options.location } : {}),
  };
}

describe("fetchPage redirect and HTTP handling", () => {
  it("revalidates a redirect target and blocks private IP destinations before connecting", async () => {
    const requestedHosts: string[] = [];
    const throttledHosts: string[] = [];
    await expect(
      fetchPage("https://www.example.com/pricing", {
        beforeRequest: async (url) => {
          throttledHosts.push(url.hostname);
        },
        resolver: publicResolver,
        request: async (url) => {
          requestedHosts.push(url.hostname);
          return response(302, {
            location: "http://169.254.169.254/latest/meta-data/",
          });
        },
      }),
    ).rejects.toBeInstanceOf(UrlSafetyError);
    expect(requestedHosts).toEqual(["www.example.com"]);
    expect(throttledHosts).toEqual(["www.example.com"]);
  });

  it("resolves every public redirect host again and returns the final safe HTML page", async () => {
    const resolvedHosts: string[] = [];
    const requestedHosts: string[] = [];
    const throttledHosts: string[] = [];
    const result = await fetchPage("https://www.example.com/pricing", {
      beforeRequest: async (url) => {
        throttledHosts.push(url.hostname);
      },
      resolver: async (hostname) => {
        resolvedHosts.push(hostname);
        return publicResolver(hostname);
      },
      request: async (url) => {
        requestedHosts.push(url.hostname);
        return url.hostname === "www.example.com"
          ? response(302, { location: "https://cdn.example.org/price-list" })
          : response(200, {
              html: "<main><h1>New price</h1><p>$59</p></main>",
            });
      },
    });
    expect(resolvedHosts).toEqual(["www.example.com", "cdn.example.org"]);
    expect(requestedHosts).toEqual(["www.example.com", "cdn.example.org"]);
    expect(throttledHosts).toEqual(["www.example.com", "cdn.example.org"]);
    expect(result).toMatchObject({
      url: "https://cdn.example.org/price-list",
      html: "<main><h1>New price</h1><p>$59</p></main>",
      httpStatus: 200,
    });
  });

  it("marks server failures as retryable without treating them as page content", async () => {
    await expect(
      fetchPage("https://www.example.com/pricing", {
        resolver: publicResolver,
        request: async () => response(503),
      }),
    ).rejects.toMatchObject<Partial<FetchError>>({
      code: "HTTP_503",
      retryable: true,
    });
  });
});
