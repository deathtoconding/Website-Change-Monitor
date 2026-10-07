import { describe, expect, it } from "vitest";
import {
  assertSafeHttpUrl,
  DnsResolutionError,
  isPublicAddress,
  normalizeHttpUrl,
  resolvePublicAddresses,
  UrlSafetyError,
} from "./url-safety.js";

const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

describe("server-side URL safety", () => {
  it("canonicalizes public HTTP(S) URLs and strips fragments", () => {
    expect(
      normalizeHttpUrl(" HTTPS://Example.com/pricing#plans ").toString(),
    ).toBe("https://example.com/pricing");
  });

  it("rejects unsafe protocols, credentials, and non-standard ports", () => {
    for (const input of [
      "file:///etc/passwd",
      "ftp://example.com",
      "https://user:password@example.com",
      "http://example.com:8080",
      "https://example.com:8443",
      "http://localhost",
      "http://service.internal",
    ]) {
      expect(() => normalizeHttpUrl(input), input).toThrow(UrlSafetyError);
    }
  });

  it("only classifies globally routable unicast addresses as public", () => {
    for (const address of ["93.184.216.34", "2001:4860:4860::8888"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      "0.0.0.0",
      "10.2.3.4",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.5",
      "192.0.2.10",
      "198.18.0.1",
      "224.0.0.1",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
      "ff02::1",
      "2001:db8::1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("rejects a DNS answer set if any answer is private (rebinding/mixed-answer defense)", async () => {
    const resolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    await expect(
      resolvePublicAddresses("example.com", resolver),
    ).rejects.toThrow(UrlSafetyError);
  });

  it("returns one pinned answer only after every DNS answer is validated", async () => {
    const resolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
    ];
    await expect(
      resolvePublicAddresses("example.com", resolver),
    ).resolves.toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("treats DNS lookup failures as a distinct retryable condition", async () => {
    await expect(
      resolvePublicAddresses("example.com", async () => {
        throw new Error("temporary resolver failure");
      }),
    ).rejects.toBeInstanceOf(DnsResolutionError);
  });

  it("performs syntax and address checks together", async () => {
    await expect(
      assertSafeHttpUrl("https://example.com/pricing", publicDns),
    ).resolves.toMatchObject({
      url: new URL("https://example.com/pricing"),
      addresses: [{ address: "93.184.216.34", family: 4 }],
    });
  });
});
