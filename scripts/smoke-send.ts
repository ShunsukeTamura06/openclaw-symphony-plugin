/**
 * Manual smoke test: send a single message to a Symphony stream.
 *
 *   1. Copy .env.example to .env and fill in real credentials
 *   2. pnpm smoke:send "Hello from OpenClaw"
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { SymphonyClient } from "../src/symphony/client.js";
import { plainToMessageMl } from "../src/messageml.js";

async function main(): Promise<void> {
  const podUrl = required("OPENCLAW_SYMPHONY_POD_URL");
  const agentUrl = required("OPENCLAW_SYMPHONY_AGENT_URL");
  const username = required("OPENCLAW_SYMPHONY_BOT_USERNAME");
  const keyPath = required("OPENCLAW_SYMPHONY_PRIVATE_KEY_PATH");
  const streamId = required("OPENCLAW_SYMPHONY_SMOKE_STREAM_ID");

  const text = process.argv.slice(2).join(" ") || "Hello from OpenClaw Symphony plugin smoke test";

  const client = new SymphonyClient({
    env: { podUrl, agentUrl },
    credentials: { username, privateKeyPem: readFileSync(keyPath, "utf8") },
  });

  const session = await client.sessionInfo();
  console.log(`[smoke] authenticated as ${session.displayName ?? session.username} (id=${session.id})`);

  const result = await client.sendMessage({
    streamId,
    messageMl: plainToMessageMl({ text }),
  });
  console.log(`[smoke] sent messageId=${result.messageId} timestamp=${result.timestamp}`);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

main().catch((err) => {
  console.error("[smoke] failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
