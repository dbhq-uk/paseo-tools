import { join } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { cancelSecret, SECRET_ROW_KIND, submitSecret } from "./shared/contracts";
import { Broker } from "./server/broker";
import { Connections } from "./server/connections";
import { createMcpServer } from "./server/mcp";
import { secretsDir } from "./server/store";

/** Providers where the injected MCP server has been shown to work. Others are left alone rather than risk a failed launch. */
const PROVIDERS = new Set(["claude"]);
const TOOLS = ["request_secret", "await_secret", "list_secrets", "forget_secret"];
/** Environment variable that carries the connection token from agent.create to agent.session_open. */
const TOKEN_ENV = "PASEO_SECRETS_CONN";

export default function contribute(server: PluginServerContext) {
  const dir = secretsDir();
  const connections = new Connections(join(dir, ".plugin-state.json"));
  let paseo: PluginHandlerContext["paseo"] | undefined;
  const remember = (_: unknown, context: { paseo: NonNullable<typeof paseo> }) => {
    paseo = context.paseo;
  };

  const broker = new Broker({
    dir,
    async publish(agentId, rowId, row) {
      if (!paseo) throw new Error("the plugin has not seen an agent event since it started");
      await paseo.agents.ref(agentId).timeline.append({
        type: "plugin",
        id: rowId,
        kind: SECRET_ROW_KIND,
        version: 1,
        data: row,
      });
    },
  });

  const http = createMcpServer({ broker, connections, dir });
  let port = connections.port ?? 0;
  const listen = (wanted: number) =>
    new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(wanted, "127.0.0.1", () => {
        http.off("error", reject);
        resolve();
      });
    });
  const ready = listen(port)
    .catch(() => listen(0))
    .then(() => {
      const address = http.address();
      if (address && typeof address === "object") {
        port = address.port;
        if (port !== connections.port) connections.setPort(port);
      }
    })
    .catch((error: Error) => console.error("Could not start the secrets MCP server:", error.message));

  server.before("agent.create", async ({ request }, context) => {
    remember(undefined, context);
    await ready;
    if (!port || !PROVIDERS.has(request.config.provider)) return request;
    const token = connections.issue();
    return {
      ...request,
      env: { ...request.env, [TOKEN_ENV]: token },
      config: {
        ...request.config,
        mcpServers: {
          ...request.config.mcpServers,
          secrets: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } },
        },
        toolPolicy: {
          ...request.config.toolPolicy,
          preapproved: [
            ...(request.config.toolPolicy?.preapproved ?? []),
            ...TOOLS.map((tool) => ({ kind: "mcp" as const, server: "secrets", tool })),
          ],
        },
      },
    };
  });

  server.before("agent.session_open", ({ request }, context) => {
    remember(undefined, context);
    const token = request.env[TOKEN_ENV];
    if (token) connections.bind(token, request.agentId);
    return undefined;
  });

  server.on("agent.turn_started", remember);
  server.on("agent.created", remember);

  server.handle(submitSecret, async ({ requestId, value }, context) => {
    remember(undefined, context);
    return broker.submit(requestId, value);
  });
  server.handle(cancelSecret, async ({ requestId }, context) => {
    remember(undefined, context);
    return { ok: await broker.cancel(requestId) };
  });

  return async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  };
}
