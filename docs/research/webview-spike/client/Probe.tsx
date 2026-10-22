import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef } from "react";
import { Platform, Text } from "react-native";
import { chunk, report } from "../shared/contracts";

export function Probe({ item, theme }: PluginTimelineItemProps<{ browserId: string }>) {
  const sendChunk = useRpc(chunk);
  const sendReport = useRpc(report);
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      const info: Record<string, unknown> = {};
      const doc = (globalThis as any).document;
      info.platform = Platform.OS;
      info.hasWindow = typeof (globalThis as any).window;
      info.userAgent = String((globalThis as any).navigator?.userAgent ?? "").slice(0, 80);
      info.hasDocument = !!doc;
      if (doc) {
        const host = doc.getElementById("paseo-browser-resident-webviews");
        info.host = !!host;
        const views: any[] = host ? Array.from(host.querySelectorAll("webview")) : [];
        info.webviewCount = views.length;
        const mine = views.find((v) => v.getAttribute("data-paseo-browser-id") === item.data.browserId);
        info.mine = !!mine;
        info.executeJavaScript = typeof mine?.executeJavaScript;
        if (mine && typeof mine.executeJavaScript === "function") {
          const t0 = Date.now();
          const big: string = await mine.executeJavaScript(
            `(()=>{let s="";for(let i=0;i<500000;i++)s+=String.fromCharCode(97+(i*7)%26);return s})()`,
          );
          info.bigChars = big.length;
          info.execMs = Date.now() - t0;
          const size = 100000;
          const total = Math.ceil(big.length / size);
          const t1 = Date.now();
          for (let i = 0; i < total; i++) await sendChunk({ index: i, total, data: big.slice(i * size, (i + 1) * size) });
          info.rpcMs = Date.now() - t1;
        }
      }
      await sendReport({ info: JSON.stringify(info) });
    })().catch((e) => sendReport({ info: "error: " + String(e?.message ?? e).slice(0, 200) }).catch(() => {}));
  }, []);
  return <Text style={{ color: theme.colors.foregroundMuted }}>Webview probe ran (read-only, on a test tab). Safe to ignore.</Text>;
}
