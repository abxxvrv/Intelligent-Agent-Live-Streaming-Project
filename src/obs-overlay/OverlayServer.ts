import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { AppConfig } from "../config.js";
import type { DebugControl } from "../debug/DebugControl.js";
import type { EventBus } from "../events/EventBus.js";
import type { OverlayEvent, RuntimeEvent } from "../types.js";
import { newId } from "../utils/id.js";
import { Logger } from "../utils/logger.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".moc3": "application/octet-stream",
  ".wav": "audio/wav"
};

export class OverlayServer {
  private readonly logger = new Logger("overlay");
  private readonly clients = new Set<ServerResponse>();
  private readonly history: OverlayEvent[] = [];
  private server = createServer((request, response) => this.handle(request, response));
  private unsubscribe?: () => void;

  constructor(
    private readonly config: AppConfig,
    private readonly bus: EventBus,
    private readonly publicDir: string,
    private readonly debugControl?: DebugControl,
    private readonly live2dRuntimeDir = join(process.cwd(), "live2d", "runtime")
  ) {}

  start(): Promise<void> {
    this.unsubscribe = this.bus.subscribe((event) => this.broadcastIfOverlay(event));
    return new Promise((resolve) => {
      this.server.listen(this.config.port, this.config.host, () => {
        this.logger.info(`overlay server: ${this.config.publicBaseUrl}/overlay`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const client of this.clients) {
      if (!client.writableEnded && !client.destroyed) client.end();
    }
    this.clients.clear();
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    void this.handleAsync(request, response).catch((error) => {
      this.logger.warn("request failed", error);
      if (!response.headersSent) sendJson(response, { ok: false, error: "request failed" }, 500);
      else response.end();
    });
  }

  private async handleAsync(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url || "/", this.config.publicBaseUrl);
    if (url.pathname === "/health") {
      sendJson(response, { ok: true, ts: Date.now() });
      return;
    }
    if (url.pathname === "/api/debug/danmaku" && request.method === "POST") {
      await this.handleDebugDanmaku(request, response);
      return;
    }
    if (url.pathname === "/api/debug/control" && request.method === "POST") {
      await this.handleDebugControl(request, response);
      return;
    }
    if (url.pathname === "/api/debug/state" && request.method === "GET") {
      sendJson(response, {
        ok: true,
        autoplayEnabled: this.debugControl?.isAutoplayEnabled() ?? false,
        events: this.history,
        ts: Date.now()
      });
      return;
    }
    if (url.pathname === "/api/events") {
      this.handleSse(response);
      return;
    }
    if (url.pathname === "/debug") {
      this.serveFile("/debug/index.html", response);
      return;
    }
    if (url.pathname === "/overlay") {
      this.serveFile("/overlay/index.html", response);
      return;
    }
    if (url.pathname.startsWith("/assets/live2d/hibiki/")) {
      this.serveLive2dFile(url.pathname, response);
      return;
    }
    this.serveFile(url.pathname, response);
  }

  private async handleDebugDanmaku(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    const user = stringField(body, "user") || "调试员";
    const text = stringField(body, "text");
    if (!text) {
      sendJson(response, { ok: false, error: "text is required" }, 400);
      return;
    }

    const event = {
      type: "danmaku" as const,
      id: newId("debug_dm"),
      ts: Date.now(),
      user: user.slice(0, 24),
      text: text.slice(0, 300),
      raw: { source: "debug" }
    };
    this.bus.publish(event);
    sendJson(response, { ok: true, event });
  }

  private async handleDebugControl(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.debugControl) {
      sendJson(response, { ok: false, error: "debug control is unavailable" }, 500);
      return;
    }
    const body = await readJsonBody(request);
    const enabled = booleanField(body, "autoplayEnabled");
    if (enabled === undefined) {
      sendJson(response, { ok: false, error: "autoplayEnabled is required" }, 400);
      return;
    }

    const autoplayEnabled = this.debugControl.setAutoplayEnabled(enabled);
    const event = {
      type: "debug-control" as const,
      id: newId("debug_ctl"),
      ts: Date.now(),
      autoplayEnabled,
      source: "debug"
    };
    this.bus.publish(event);
    sendJson(response, { ok: true, autoplayEnabled });
  }

  private handleSse(response: ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin": "*"
    });
    if (!writeRawSse(response, ": connected\n\n")) return;
    for (const event of this.history) {
      if (!writeSse(response, event)) return;
    }
    this.clients.add(response);
    response.on("close", () => this.clients.delete(response));
    response.on("error", () => this.clients.delete(response));
  }

  private broadcastIfOverlay(event: RuntimeEvent): void {
    if (!isOverlayEvent(event)) return;
    this.history.push(event);
    while (this.history.length > 50) this.history.shift();
    for (const client of Array.from(this.clients)) {
      if (!writeSse(client, event)) this.clients.delete(client);
    }
  }

  private serveFile(pathname: string, response: ServerResponse): void {
    const relativePath = pathname === "/" ? "overlay/index.html" : pathname.replace(/^[/\\]+/, "");
    const safePath = normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(this.publicDir, safePath);
    if (!filePath.startsWith(this.publicDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "content-type": MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream"
    });
    createReadStream(filePath).pipe(response);
  }

  private serveLive2dFile(pathname: string, response: ServerResponse): void {
    const relativePath = pathname.replace(/^\/assets\/live2d\/hibiki\/?/, "");
    this.serveStaticFile(this.live2dRuntimeDir, relativePath || "hibiki.model3.json", response);
  }

  private serveStaticFile(rootDir: string, relativePath: string, response: ServerResponse): void {
    const safePath = normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(rootDir, safePath);
    if (!filePath.startsWith(rootDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "content-type": MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream"
    });
    createReadStream(filePath).pipe(response);
  }
}

function writeSse(response: ServerResponse, event: OverlayEvent): boolean {
  return writeRawSse(response, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function writeRawSse(response: ServerResponse, payload: string): boolean {
  if (response.writableEnded || response.destroyed) return false;
  try {
    response.write(payload);
    return true;
  } catch {
    return false;
  }
}

function isOverlayEvent(event: RuntimeEvent): event is OverlayEvent {
  return [
    "danmaku",
    "gift",
    "live-system",
    "game-state",
    "agent-reply",
    "agent-trace",
    "voice",
    "avatar",
    "tool-call",
    "debug-control"
  ].includes(event.type);
}

function sendJson(response: ServerResponse, value: unknown, statusCode = 200): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 16_384) throw new Error("Request body is too large");
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanField(obj: Record<string, unknown>, key: string): boolean | undefined {
  const value = obj[key];
  return typeof value === "boolean" ? value : undefined;
}
