import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DemoApp, DemoEvent } from "./app.ts";

const PAGE = join(dirname(fileURLToPath(import.meta.url)), "page.html");
const MAX_BODY_BYTES = 20_000;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
}

function openEventStream(app: DemoApp, request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  response.write(": connected\n\n"); // sends the headers now, so the page knows it is connected
  const write = (event: DemoEvent) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  const stop = app.onEvent(write);
  app.deliverQueued();
  request.on("close", stop);
}

async function route(app: DemoApp, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const key = `${request.method} ${request.url}`;
  switch (key) {
    case "GET /":
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(readFileSync(PAGE));
      return;
    case "GET /events":
      openEventStream(app, request, response);
      return;
    case "POST /message": {
      const { text } = await readJson(request);
      if (typeof text !== "string" || !text.trim()) return sendJson(response, 400, { error: "text is required" });
      return sendJson(response, 200, await app.send(text));
    }
    case "POST /approve": {
      const { approval_id: approvalId } = await readJson(request);
      if (typeof approvalId !== "string") return sendJson(response, 400, { error: "approval_id is required" });
      return sendJson(response, 200, await app.approve(approvalId));
    }
    case "POST /reset":
      await app.reset();
      return sendJson(response, 200, { ok: true });
    case "POST /dev/force-timeout":
      app.forceTimeout();
      return sendJson(response, 200, { ok: true, next_book: "timeout_booked" });
    case "GET /dev/injected-provider":
      return sendJson(response, 200, app.injectedProvider());
    default:
      return sendJson(response, 404, { error: "not found" });
  }
}

export function createDemoServer(app: DemoApp): Server {
  return createServer((request, response) => {
    route(app, request, response).catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) });
    });
  });
}
