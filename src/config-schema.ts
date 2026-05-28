import { z } from "zod";

export const SymphonyAccountConfigSchema = z.object({
  podUrl: z.string().url().describe("Symphony Pod base URL (e.g. https://acme.symphony.com)"),
  agentUrl: z.string().url().describe("Symphony Agent base URL (e.g. https://acme-agent.symphony.com)"),
  relayUrl: z
    .string()
    .url()
    .optional()
    .describe("Optional Symphony relay URL for the key manager pubkey endpoint."),
  username: z.string().min(1).describe("Symphony bot service-account username"),
  privateKeyPath: z
    .string()
    .min(1)
    .describe("Absolute path to the bot's RSA private key (PKCS#8 PEM)"),
  enabled: z.boolean().optional().default(true),
  datafeedTag: z.string().optional(),
  jwtTtlSec: z.number().int().min(30).max(600).optional(),
  allowedUsers: z
    .array(z.string())
    .optional()
    .describe(
      "Whitelist of users allowed to interact with the bot (userId / email / username). Empty => all allowed.",
    ),
  allowedRooms: z
    .array(z.string())
    .optional()
    .describe(
      "Whitelist of room/group streamIds the bot will engage with. Applies only to non-DM conversations. Empty => all allowed.",
    ),
});

export const SymphonyChannelConfigSchema = z
  .object({
    defaultAccount: z.string().optional(),
    accounts: z.record(z.string(), SymphonyAccountConfigSchema).optional(),
  })
  .merge(SymphonyAccountConfigSchema.partial())
  .describe("Symphony channel configuration");

export type SymphonyChannelConfigShape = z.infer<typeof SymphonyChannelConfigSchema>;
