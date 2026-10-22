import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Probe } from "./client/Probe";
import { ROW_KIND, rowSchema } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({ kind: ROW_KIND, version: 1, schema: rowSchema, Component: Probe });
  return () => {};
}
