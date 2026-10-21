import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FileViewerPanel } from "./client/main.js";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "files",
    title: "Viewer",
    icon: "FileText",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: FileViewerPanel,
  });

  client.addCommandCenterItem({
    id: "open-viewer",
    title: "Open file viewer",
    icon: "FileText",
    context: "workspace",
    keywords: ["pdf", "document", "spreadsheet", "image", "view"],
    onSelect({ openPanel }) {
      openPanel("files");
    },
  });

  return () => {};
}
