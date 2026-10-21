import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Letters, digits, underscore and hyphen. No dot, so a name can never be a hidden file or a path. */
export const NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
export const MAX_VALUE_BYTES = 64 * 1024;

export const SECRET_ROW_KIND = "secret-request";

/**
 * What the timeline row carries. It never holds the secret: the row is canonical
 * history and is refetched, so anything in it is as public as the chat.
 */
export const secretRowSchema = z.object({
  requestId: z.string(),
  name: z.string(),
  purpose: z.string(),
  status: z.enum(["waiting", "stored", "cancelled", "expired"]),
  replacing: z.boolean(),
});
export type SecretRow = z.output<typeof secretRowSchema>;

/** The box sends the value here. The reply says only whether it was kept. */
export const submitSecret = defineRpc({
  name: "secrets.submit",
  input: z.object({ requestId: z.string(), value: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), message: z.string().optional() }),
});

export const cancelSecret = defineRpc({
  name: "secrets.cancel",
  input: z.object({ requestId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});
