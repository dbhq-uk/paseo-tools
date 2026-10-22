import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ROW_KIND = "webview-spike";
export const rowSchema = z.object({ browserId: z.string() });

export const start = defineRpc({
  name: "spike.start",
  input: z.object({ agentId: z.string(), browserId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});
export const chunk = defineRpc({
  name: "spike.chunk",
  input: z.object({ index: z.number(), total: z.number(), data: z.string() }),
  output: z.object({ ok: z.boolean() }),
});
export const report = defineRpc({
  name: "spike.report",
  input: z.object({ info: z.string() }),
  output: z.object({ ok: z.boolean() }),
});
