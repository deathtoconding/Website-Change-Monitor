import type { DiffLine, Frequency } from "./types.js";

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  hourly: "Every hour",
  "six-hourly": "Every 6 hours",
  daily: "Daily",
};

const FREQUENCY_MS: Record<Frequency, number> = {
  hourly: 60 * 60 * 1000,
  "six-hourly": 6 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
};

export function nextCheckDate(from: Date, frequency: Frequency): Date {
  return new Date(from.getTime() + FREQUENCY_MS[frequency]);
}

/**
 * Client-side URL preflight only. Production fetching must repeat validation on
 * the server, resolve DNS, reject private/reserved answers, and revalidate each
 * redirect immediately before connecting.
 */
export function validateMonitorUrl(input: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return "Enter a complete URL, such as https://example.com/pricing.";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Only HTTP and HTTPS URLs can be monitored.";
  }
  if (parsed.username || parsed.password) {
    return "URLs containing a username or password are not supported.";
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return "This address is not available for monitoring.";
  }
  if (isPrivateIpLiteral(host)) {
    return "Private or reserved IP addresses cannot be monitored.";
  }

  return null;
}

function isPrivateIpLiteral(host: string): boolean {
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.map(Number).slice(1);
    if (octets.some((octet) => octet < 0 || octet > 255)) return true;
    const [a, b, c] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 &&
        (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  // URL.hostname retains brackets for IPv6 literals in modern browsers.
  const ipv6 = host.replace(/^\[|\]$/g, "");
  if (ipv6.includes(":")) {
    const value = ipv6.toLowerCase();
    return (
      value === "::" ||
      value === "::1" ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      value.startsWith("fe8") ||
      value.startsWith("fe9") ||
      value.startsWith("fea") ||
      value.startsWith("feb") ||
      value.startsWith("ff") ||
      value.startsWith("2001:db8:") ||
      value.startsWith("::ffff:")
    );
  }

  return false;
}

/** Normalize text snapshots into a stable, line-oriented representation. */
export function normalizeContent(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Deterministic line diff using LCS for ordinary pages. For very large text,
 * bound memory by preserving the common prefix and suffix and marking the
 * middle as one removed/added block.
 */
export function diffText(beforeText: string, afterText: string): DiffLine[] {
  const before = normalizeContent(beforeText).split("\n").filter(Boolean);
  const after = normalizeContent(afterText).split("\n").filter(Boolean);
  const maxCells = 90_000;

  if (before.length * after.length > maxCells) {
    return boundedDiff(before, after);
  }

  const rows = before.length + 1;
  const cols = after.length + 1;
  const table = Array.from({ length: rows }, () => new Uint32Array(cols));

  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        before[i] === after[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const output: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      output.push({ kind: "unchanged", text: before[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      output.push({ kind: "removed", text: before[i] });
      i += 1;
    } else {
      output.push({ kind: "added", text: after[j] });
      j += 1;
    }
  }
  while (i < before.length) output.push({ kind: "removed", text: before[i++] });
  while (j < after.length) output.push({ kind: "added", text: after[j++] });

  return output;
}

function boundedDiff(before: string[], after: string[]): DiffLine[] {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  )
    prefix += 1;

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix += 1;

  return [
    ...before
      .slice(0, prefix)
      .map((text) => ({ kind: "unchanged" as const, text })),
    ...before
      .slice(prefix, before.length - suffix)
      .map((text) => ({ kind: "removed" as const, text })),
    ...after
      .slice(prefix, after.length - suffix)
      .map((text) => ({ kind: "added" as const, text })),
    ...before
      .slice(before.length - suffix)
      .map((text) => ({ kind: "unchanged" as const, text })),
  ];
}

export function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function getSuggestedName(url: string): string {
  const domain = getDomain(url);
  const firstPart = domain.split(".")[0] ?? domain;
  return firstPart.charAt(0).toUpperCase() + firstPart.slice(1) + " website";
}

export function formatRelativeTime(
  value: string | null,
  now = Date.now(),
): string {
  if (!value) return "Not checked yet";
  const difference = new Date(value).getTime() - now;
  if (Number.isNaN(difference)) return "—";
  const elapsed = Math.abs(difference);
  const minutes = Math.round(elapsed / 60_000);
  const hours = Math.round(elapsed / 3_600_000);
  const days = Math.round(elapsed / 86_400_000);

  let amount: string;
  if (minutes < 1) amount = "just now";
  else if (minutes < 60) amount = `${minutes}m`;
  else if (hours < 24) amount = `${hours}h`;
  else amount = `${days}d`;

  return difference > 0 ? `in ${amount}` : `${amount} ago`;
}

export function formatDateTime(value: string | null): string {
  if (!value) return "No checks yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
