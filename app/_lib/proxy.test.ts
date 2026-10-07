import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { proxyToApi } from "./proxy";

async function withServer<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (origin: string) => Promise<T>,
): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("Next.js API proxy", () => {
  it("forwards cookies, origin/CSRF headers, query strings, and response cookies", async () => {
    await withServer(
      async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        response.setHeader("content-type", "application/json");
        response.setHeader("set-cookie", [
          "wcm.sid=session; Path=/; HttpOnly",
          "csrf=rotated; Path=/",
        ]);
        response.end(
          JSON.stringify({
            path: request.url,
            forwardedHost: request.headers["x-forwarded-host"],
            forwardedProto: request.headers["x-forwarded-proto"],
            origin: request.headers.origin,
            cookie: request.headers.cookie,
            csrf: request.headers["x-csrf-token"],
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
      async (origin) => {
        const request = new Request(
          "https://watchtower.example/api/auth/login?continue=1",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "https://watchtower.example",
              cookie: "wcm.sid=old-session",
              "x-csrf-token": "csrf-secret",
              "x-forwarded-host": "watchtower.example",
              "x-forwarded-proto": "https",
            },
            body: JSON.stringify({ email: "user@example.com" }),
          },
        );

        const response = await proxyToApi(request, "/api/auth/login", origin);
        const result = (await response.json()) as Record<string, unknown>;
        expect(response.status).toBe(200);
        expect(result).toMatchObject({
          path: "/api/auth/login?continue=1",
          forwardedHost: "watchtower.example",
          forwardedProto: "https",
          origin: "https://watchtower.example",
          cookie: "wcm.sid=old-session",
          csrf: "csrf-secret",
          body: JSON.stringify({ email: "user@example.com" }),
        });
        expect(response.headers.getSetCookie()).toEqual([
          "wcm.sid=session; Path=/; HttpOnly",
          "csrf=rotated; Path=/",
        ]);
      },
    );
  });

  it("rejects oversized webhook and API bodies before proxying them", async () => {
    const server = createServer((_request, response) =>
      response.end("should not run"),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    try {
      const apiBody = new Request("http://watchtower.example/api/monitors", {
        method: "POST",
        body: "x".repeat(65_537),
      });
      const apiResponse = await proxyToApi(
        apiBody,
        "/api/monitors",
        `http://127.0.0.1:${address.port}`,
      );
      expect(apiResponse.status).toBe(413);

      const webhookBody = new Request(
        "http://watchtower.example/api/billing/webhook",
        {
          method: "POST",
          body: "x".repeat(1_048_577),
        },
      );
      const webhookResponse = await proxyToApi(
        webhookBody,
        "/api/billing/webhook",
        `http://127.0.0.1:${address.port}`,
      );
      expect(webhookResponse.status).toBe(413);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
