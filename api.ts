export { symphonyPlugin, SYMPHONY_DEFAULT_ACCOUNT_ID } from "./src/plugin.js";
export { symphonyOutboundAdapter, symphonyMessageAdapter, sendSymphonyMessage } from "./src/outbound.js";
export { symphonyGatewayAdapter } from "./src/gateway.js";
export { symphonyStatusAdapter } from "./src/status.js";
export { symphonySetupAdapter, describeSymphonyAccount } from "./src/setup.js";
export { SymphonyChannelConfigSchema, SymphonyAccountConfigSchema } from "./src/config-schema.js";
export {
  getAccountConfig,
  listAccountIds,
  resolveDefaultAccountId,
  isAccountConfigured,
} from "./src/config.js";
export { plainToMessageMl, messageMlToPlain, escapeXml, unescapeXml } from "./src/messageml.js";
export {
  markdownToMessageMl,
  markdownToMessageMlBody,
} from "./src/markdown-to-messageml.js";
export { normalizeInboundMessage, extractMessageFromEvent } from "./src/normalize.js";
export type {
  SymphonyAccountConfig,
  ResolvedSymphonyAccount,
  SymphonyAccountProbe,
  SymphonyChannelConfig,
} from "./src/types.js";
export type { NormalizedInboundMessage, NormalizedAttachment } from "./src/normalize.js";

// Lower-level Symphony client surface (re-export so consumers can import
// without depending on internal paths).
export {
  SymphonyClient,
  authenticateBot,
  createBotJwt,
  tokensExpired,
  SymphonyHttpError,
  runDatafeedLoop,
} from "./src/symphony/index.js";
export type {
  SymphonyEnvironment,
  SymphonyCredentials,
  SymphonyTokens,
  SymphonyClientOptions,
  SymphonyUser,
  SymphonyStream,
  SymphonyStreamType,
  SymphonyMessage,
  SymphonyAttachmentInfo,
  SymphonyAttachmentInput,
  SendMessageInput,
  CreateImInput,
  Datafeed,
  DatafeedEvent,
  DatafeedEventEnvelope,
} from "./src/symphony/index.js";
