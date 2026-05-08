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
});

export const SymphonyChannelConfigSchema = z
  .object({
    defaultAccount: z.string().optional(),
    accounts: z.record(z.string(), SymphonyAccountConfigSchema).optional(),
  })
  .merge(SymphonyAccountConfigSchema.partial())
  .describe("Symphony channel configuration");

export type SymphonyChannelConfigShape = z.infer<typeof SymphonyChannelConfigSchema>;
