export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

let csrfToken: string | null = null;

export function saveCsrfToken(value: string | undefined): void {
  if (value) csrfToken = value;
}

export function clearCsrfToken(): void {
  csrfToken = null;
}

async function getCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;
  const response = await fetch("/api/auth/csrf", {
    credentials: "same-origin",
    cache: "no-store",
  });
  const result = (await response.json().catch(() => ({}))) as {
    csrfToken?: string;
    error?: string;
  };
  if (!response.ok || !result.csrfToken) {
    throw new ApiError(
      result.error ?? "Could not start a secure session.",
      response.status,
    );
  }
  csrfToken = result.csrfToken;
  return csrfToken;
}

export async function apiRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined)
    headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
    headers.set("X-CSRF-Token", await getCsrfToken());
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch {
    throw new ApiError(
      "The server could not be reached. Check your connection and try again.",
      0,
    );
  }

  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type") ?? "";
  const payload: unknown = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : await response.text().catch(() => "");
  if (!response.ok) {
    const data =
      typeof payload === "object" && payload !== null
        ? (payload as { error?: unknown; code?: unknown })
        : null;
    const message =
      typeof data?.error === "string"
        ? data.error
        : `Request failed (${response.status}).`;
    const code = typeof data?.code === "string" ? data.code : undefined;
    throw new ApiError(message, response.status, code);
  }
  return payload as T;
}
