const apiOrigin = process.env.API_INTERNAL_ORIGIN ?? "http://127.0.0.1:4000";

class ProxyBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the proxy limit.");
    this.name = "ProxyBodyTooLargeError";
  }
}

async function readLimitedBody(
  request: Request,
  limit: number,
): Promise<ArrayBuffer> {
  const reader = request.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        await reader.cancel().catch(() => undefined);
        throw new ProxyBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

export async function proxyToApi(
  request: Request,
  path: string,
  upstreamOrigin = apiOrigin,
): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(path, upstreamOrigin);
  targetUrl.search = incomingUrl.search;

  const headers = new Headers(request.headers);
  const forwardedHost =
    headers.get("x-forwarded-host") ?? headers.get("host") ?? incomingUrl.host;
  const forwardedProto =
    headers.get("x-forwarded-proto") ?? incomingUrl.protocol.slice(0, -1);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.set("x-forwarded-host", forwardedHost.split(",")[0].trim());
  headers.set("x-forwarded-proto", forwardedProto.split(",")[0].trim());

  const hasBody = !["GET", "HEAD"].includes(request.method);
  const bodyLimit = path === "/api/billing/webhook" ? 1_048_576 : 65_536;
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > bodyLimit) {
    return Response.json(
      { error: "Request body is too large." },
      { status: 413 },
    );
  }
  let body: ArrayBuffer | undefined;
  if (hasBody) {
    try {
      body = await readLimitedBody(request, bodyLimit);
    } catch (error) {
      if (error instanceof ProxyBodyTooLargeError)
        return Response.json(
          { error: "Request body is too large." },
          { status: 413 },
        );
      return Response.json({ error: "Invalid request body." }, { status: 400 });
    }
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      redirect: "manual",
    });
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("connection");
    responseHeaders.delete("transfer-encoding");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return Response.json(
      { error: "The API is temporarily unavailable." },
      { status: 503 },
    );
  }
}
