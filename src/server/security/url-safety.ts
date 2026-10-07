import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export type AddressRecord = { address: string; family: number };
export type Resolver = (hostname: string) => Promise<AddressRecord[]>;

export class UrlSafetyError extends Error {
  readonly code = "URL_NOT_ALLOWED";

  constructor(message = "The URL is not allowed for monitoring.") {
    super(message);
    this.name = "UrlSafetyError";
  }
}

export class DnsResolutionError extends Error {
  readonly code = "DNS_LOOKUP_FAILED";
  readonly retryable = true;

  constructor() {
    super("The website hostname could not be resolved temporarily.");
    this.name = "DnsResolutionError";
  }
}

const BLOCKED_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.azure.internal",
  "instance-data.ec2.internal",
  "metadata.tencentyun.com",
]);
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".test",
  ".invalid",
  ".example",
];

/** Parse and canonicalize an HTTP(S) URL before DNS resolution or network access. */
export function normalizeHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UrlSafetyError("Enter a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlSafetyError("Only HTTP and HTTPS URLs are supported.");
  }
  if (url.username || url.password) {
    throw new UrlSafetyError("URLs containing credentials are not supported.");
  }
  if (
    url.port &&
    !(
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    )
  ) {
    throw new UrlSafetyError(
      "Only the standard HTTP and HTTPS ports are allowed.",
    );
  }

  const hostname = unbracket(url.hostname).toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname.includes("%")) throw new UrlSafetyError();
  if (
    BLOCKED_HOSTS.has(hostname) ||
    BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    hostname === "localhost"
  ) {
    throw new UrlSafetyError(
      "Local and internal hostnames cannot be monitored.",
    );
  }

  // Fragments are never sent over HTTP and should not create separate monitors.
  url.hash = "";
  return url;
}

/** Only globally routable unicast addresses are allowed as connection targets. */
export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.parse(address).range() === "unicast";
  } catch {
    return false;
  }
}

export async function resolvePublicAddresses(
  hostnameInput: string,
  resolver: Resolver = defaultResolver,
): Promise<AddressRecord[]> {
  const hostname = unbracket(hostnameInput).toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname.includes("%")) throw new UrlSafetyError();

  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await resolver(hostname).catch(() => {
        throw new DnsResolutionError();
      });

  if (addresses.length === 0)
    throw new UrlSafetyError(
      "The website hostname did not resolve to an address.",
    );
  if (addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new UrlSafetyError(
      "The website resolves to a private or reserved network address.",
    );
  }

  // Pin one of the validated answers for the lifetime of a single request.
  return [addresses[0]];
}

export async function assertSafeHttpUrl(
  input: string,
  resolver?: Resolver,
): Promise<{ url: URL; addresses: AddressRecord[] }> {
  const url = normalizeHttpUrl(input);
  const addresses = await resolvePublicAddresses(url.hostname, resolver);
  return { url, addresses };
}

async function defaultResolver(hostname: string): Promise<AddressRecord[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}
