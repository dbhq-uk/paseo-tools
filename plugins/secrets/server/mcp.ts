import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { NAME_PATTERN } from "../shared/contracts";
import type { Broker, Outcome } from "./broker";
import type { Connections } from "./connections";
import { listSecrets, pathFor, removeSecret } from "./store";

const MAX_BODY_BYTES = 64 * 1024;
export const MAX_WAIT_SECONDS = 45;
const PROTOCOL_VERSION = "2025-03-26";

type Json = Record<string, unknown>;

export interface McpDeps {
  broker: Broker;
  connections: Connections;
  dir: string;
}

const NAME_HELP =
  "Letters, digits, underscore and hyphen, up to 64 characters (for example STRIPE_KEY). Not a path.";

const TOOLS = [
  {
    name: "request_secret",
    description:
      "Ask the operator for a secret such as an API key or password. A masked box appears in their Paseo app, and the value is saved to a protected file on this machine. You get the file path back, never the value. Use this instead of asking them to paste a secret into the chat. Read it where you need it, for example: export NAME=\"$(cat \"<path>\")\". Do not print it or write it into a file in the repository.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: NAME_HELP },
        purpose: { type: "string", description: "One short sentence the operator will see: what it is for and where it came from." },
      },
      required: ["name", "purpose"],
    },
  },
  {
    name: "await_secret",
    description: `Wait for a request_secret that came back as "waiting". Waits up to ${MAX_WAIT_SECONDS} seconds; call it again if it is still waiting.`,
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string" },
        waitSeconds: { type: "number", description: `Seconds to wait, at most ${MAX_WAIT_SECONDS}.` },
      },
      required: ["requestId"],
    },
  },
  {
    name: "list_secrets",
    description: "List the names of the secrets already stored, with their paths. Never shows values. Check this before asking again.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "forget_secret",
    description: "Delete a stored secret. Do this after moving it to its permanent home, or when it is no longer needed.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: NAME_HELP } }, required: ["name"] },
  },
];

function text(message: string, isError = false): Json {
  return { content: [{ type: "text", text: message }], ...(isError ? { isError: true } : {}) };
}

function describe(outcome: Outcome | undefined): Json {
  if (!outcome) return text("No such request. It may have been made before the plugin restarted. Ask again.", true);
  switch (outcome.status) {
    case "stored":
      return text(
        `Stored ${outcome.name}. File: ${outcome.path}\nRead it where you need it, for example: export ${outcome.name}="$(cat "${outcome.path}")"\nDo not print it, log it, or copy it into the repository.`,
      );
    case "waiting":
      return text(
        `Waiting for the operator to enter ${outcome.name}. Call await_secret with requestId "${outcome.requestId}" to keep waiting.`,
      );
    case "cancelled":
      return text(`The operator declined to provide ${outcome.name}. Do not ask again unless they say so.`, true);
    case "expired":
      return text(`The request for ${outcome.name} timed out with no answer. Ask again if it is still needed.`, true);
  }
}

function waitMs(value: unknown): number {
  const seconds = typeof value === "number" && Number.isFinite(value) ? value : MAX_WAIT_SECONDS;
  return Math.max(0, Math.min(MAX_WAIT_SECONDS, seconds)) * 1000;
}

async function callTool(deps: McpDeps, agentId: string, name: string, args: Json): Promise<Json> {
  switch (name) {
    case "request_secret": {
      const secretName = typeof args.name === "string" ? args.name : "";
      if (!NAME_PATTERN.test(secretName)) return text(`That name is not allowed. ${NAME_HELP}`, true);
      const purpose = (typeof args.purpose === "string" ? args.purpose : "").trim().slice(0, 300) || "No reason given.";
      let opened;
      try {
        opened = await deps.broker.request(agentId, secretName, purpose);
      } catch {
        return text(
          "The box could not be shown to the operator, so nothing was requested. This usually means the secrets plugin was just reloaded. Try again after your next turn, or ask the operator to restart this agent.",
          true,
        );
      }
      if (opened.status !== "waiting") return describe(opened);
      return describe(await deps.broker.wait(opened.requestId, waitMs(undefined)));
    }
    case "await_secret": {
      const requestId = typeof args.requestId === "string" ? args.requestId : "";
      return describe(await deps.broker.wait(requestId, waitMs(args.waitSeconds)));
    }
    case "list_secrets": {
      const names = listSecrets(deps.dir);
      if (names.length === 0) return text("No secrets are stored.");
      return text(names.map((n) => `${n}: ${pathFor(deps.dir, n)}`).join("\n"));
    }
    case "forget_secret": {
      const secretName = typeof args.name === "string" ? args.name : "";
      if (!NAME_PATTERN.test(secretName)) return text(`That name is not allowed. ${NAME_HELP}`, true);
      return removeSecret(deps.dir, secretName)
        ? text(`Deleted ${secretName}.`)
        : text(`${secretName} is not stored.`, true);
    }
    default:
      return text(`Unknown tool ${name}.`, true);
  }
}

/** One JSON-RPC message in, one out. Notifications return `undefined`. */
export async function handleMessage(deps: McpDeps, agentId: string, message: Json): Promise<Json | undefined> {
  const id = message.id;
  const method = typeof message.method === "string" ? message.method : "";
  if (id === undefined) return undefined;
  const ok = (result: Json) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  switch (method) {
    case "initialize": {
      const params = (message.params ?? {}) as Json;
      const version = typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION;
      return ok({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "secrets", version: "0.1.0" } });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const params = (message.params ?? {}) as Json;
      const args = (params.arguments ?? {}) as Json;
      return ok(await callTool(deps, agentId, String(params.name ?? ""), args));
    }
    default:
      return fail(-32601, "Method not found.");
  }
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(undefined));
  });
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

/** The HTTP face of the MCP server. Bearer token required; one token per agent. */
export function createMcpServer(deps: McpDeps): Server {
  return createServer(async (req, res) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    const agentId = bearer ? deps.connections.agentFor(bearer) : null;
    if (!agentId) return send(res, 401, { error: "unauthorised" });
    if (req.method !== "POST" || !(req.url ?? "").startsWith("/mcp")) {
      res.setHeader("allow", "POST");
      return send(res, 405, { error: "POST only" });
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = raw === undefined ? undefined : JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
      return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
    }
    const messages = Array.isArray(parsed) ? (parsed as Json[]) : [parsed as Json];
    const replies = (await Promise.all(messages.map((m) => handleMessage(deps, agentId, m)))).filter(
      (r): r is Json => r !== undefined,
    );
    if (replies.length === 0) return send(res, 202);
    send(res, 200, Array.isArray(parsed) ? replies : replies[0]);
  });
}
