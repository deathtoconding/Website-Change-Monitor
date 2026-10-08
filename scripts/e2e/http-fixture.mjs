import { createServer } from "node:http";

const port = Number(process.env.FIXTURE_PORT ?? 18_088);
const state = {
  content: "Qualification fixture baseline v1",
  failuresRemaining: 0,
  unsupportedContentType: false,
  requestsByPath: {},
};

const server = createServer(async (request, response) => {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "fixture"}`,
  );

  if (request.method === "GET" && url.pathname === "/__health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/__stats") {
    sendJson(response, 200, { requestsByPath: state.requestsByPath });
    return;
  }

  if (request.method === "POST" && url.pathname === "/__control") {
    try {
      const body = JSON.parse(await readRequestBody(request));
      if (typeof body.content === "string") state.content = body.content;
      if (
        Number.isInteger(body.failuresRemaining) &&
        body.failuresRemaining >= 0
      )
        state.failuresRemaining = body.failuresRemaining;
      if (typeof body.unsupportedContentType === "boolean")
        state.unsupportedContentType = body.unsupportedContentType;
      sendJson(response, 200, { status: "updated" });
    } catch {
      sendJson(response, 400, { error: "Invalid fixture control request." });
    }
    return;
  }

  state.requestsByPath[url.pathname] =
    (state.requestsByPath[url.pathname] ?? 0) + 1;
  if (url.pathname === "/flaky" && state.failuresRemaining > 0) {
    state.failuresRemaining -= 1;
    response.writeHead(503, { "content-type": "text/html; charset=utf-8" });
    response.end("<main>Temporary fixture failure</main>");
    return;
  }

  if (url.pathname === "/unsupported" || state.unsupportedContentType) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ error: "Unsupported content type fixture." }),
    );
    return;
  }

  const content = escapeHtml(state.content);
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    `<!doctype html><html><body><main>${content}</main></body></html>`,
  );
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Qualification HTTP fixture listening on ${port}`);
});

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8_192) throw new Error("Fixture control body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function shutdown() {
  server.close(() => process.exit(0));
}
