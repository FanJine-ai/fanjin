import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, Plugin } from "vite";

const PROXY_PREFIX = "/api-proxy";
const PROXY_BASE_HEADER = "x-proxy-base-url";
const PROXY_BASE_QUERY = "__proxy_base";

function readProxyBase(req: IncomingMessage, requestUrl: URL): string | null {
  const fromQuery = requestUrl.searchParams.get(PROXY_BASE_QUERY);
  if (fromQuery?.trim()) return fromQuery.trim();

  const fromHeader = req.headers[PROXY_BASE_HEADER];
  if (typeof fromHeader === "string" && fromHeader.trim()) return fromHeader.trim();
  return null;
}

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function createProxyMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const rawUrl = req.url ?? "";
    if (!rawUrl.startsWith(PROXY_PREFIX)) {
      next();
      return;
    }

    void handleProxy(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "代理转发失败";
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
      res.end(message);
    });
  };
}

async function handleProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const targetBase = readProxyBase(req, requestUrl);
  if (!targetBase) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Missing proxy base URL");
    return;
  }

  const proxyPath = requestUrl.pathname.slice(PROXY_PREFIX.length) || "/";
  const trimmedBase = targetBase.replace(/\/+$/, "");
  requestUrl.searchParams.delete(PROXY_BASE_QUERY);
  const search = requestUrl.searchParams.toString();
  const targetUrl = `${trimmedBase}${proxyPath}${search ? `?${search}` : ""}`;

  const forwardHeaders = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "connection" || lower === PROXY_BASE_HEADER || lower === "content-length") continue;
    if (typeof value === "string") {
      forwardHeaders.set(key, value);
    } else if (Array.isArray(value)) {
      forwardHeaders.set(key, value.join(", "));
    }
  }

  const body = await readBody(req);
  const response = await fetch(targetUrl, {
    method: req.method,
    headers: forwardHeaders,
    body: body ? new Uint8Array(body) : undefined,
  });

  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key === "transfer-encoding") return;
    res.setHeader(key, value);
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}

export function apiProxyPlugin(): Plugin {
  const attach = (server: { middlewares: Connect.Server }) => {
    server.middlewares.use(createProxyMiddleware());
  };

  return {
    name: "api-proxy",
    configureServer: attach,
    configurePreviewServer: attach,
  };
}
