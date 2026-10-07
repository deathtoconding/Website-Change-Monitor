import { proxyToApi } from "../../_lib/proxy";

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { path } = await context.params;
  const encodedPath = path
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return proxyToApi(request, `/api/${encodedPath}`);
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
