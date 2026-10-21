import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SecretRequest } from "./client/SecretRequest";
import { SECRET_ROW_KIND, secretRowSchema } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({
    kind: SECRET_ROW_KIND,
    version: 1,
    schema: secretRowSchema,
    Component: SecretRequest,
  });
  return () => {};
}
