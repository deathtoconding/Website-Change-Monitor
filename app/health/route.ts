import { proxyToApi } from "../_lib/proxy";

export const GET = (request: Request) => proxyToApi(request, "/health");
