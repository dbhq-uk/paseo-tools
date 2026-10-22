import { createHash } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { chunk, report, ROW_KIND, start } from "./shared/contracts";

const expected = (() => {
  let s = "";
  for (let i = 0; i < 500000; i++) s += String.fromCharCode(97 + ((i * 7) % 26));
  return s;
})();

export default function contribute(server: PluginServerContext) {
  const parts = new Map<number, string>();
  server.handle(start, async ({ agentId, browserId }, { paseo }) => {
    await paseo.agents.ref(agentId).timeline.append({ type: "plugin", id: "spike-" + Date.now(), kind: ROW_KIND, version: 1, data: { browserId } });
    return { ok: true };
  });
  server.handle(chunk, async ({ index, total, data }) => {
    parts.set(index, data);
    if (parts.size === total) {
      const joined = Array.from({ length: total }, (_, i) => parts.get(i) ?? "").join("");
      const sha = createHash("sha256").update(joined).digest("hex").slice(0, 16);
      console.log(`SPIKE bytes received: chars=${joined.length} chunks=${total} identical_to_page_content=${joined === expected} sha=${sha}`);
      parts.clear();
    }
    return { ok: true };
  });
  server.handle(report, async ({ info }) => {
    console.log("SPIKE client report: " + info);
    return { ok: true };
  });
  return () => {};
}
