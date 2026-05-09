/**
 * Manual smoke test: subscribe to Datafeed v5 for 30s and print incoming messages.
 *
 *   pnpm smoke:datafeed
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { SymphonyClient } from "../src/symphony/client.js";
import { runDatafeedLoop } from "../src/symphony/datafeed-loop.js";
import { extractMessageFromEvent, normalizeInboundMessage } from "../src/normalize.js";

const TIMEOUT_SEC = Number(process.env.OPENCLAW_SYMPHONY_DATAFEED_TIMEOUT_SEC ?? 30);

async function main(): Promise<void> {
  const podUrl = required("OPENCLAW_SYMPHONY_POD_URL");
  const agentUrl = required("OPENCLAW_SYMPHONY_AGENT_URL");
  const username = required("OPENCLAW_SYMPHONY_BOT_USERNAME");
  const keyPath = required("OPENCLAW_SYMPHONY_PRIVATE_KEY_PATH");

  const client = new SymphonyClient({
    env: { podUrl, agentUrl },
    credentials: { username, privateKeyPem: readFileSync(keyPath, "utf8") },
  });

  const session = await client.sessionInfo();
  const selfUserId = session.id;
  console.log(`[smoke] subscribed as ${session.displayName ?? session.username} (id=${selfUserId})`);
  console.log(`[smoke] listening for ${TIMEOUT_SEC}s — send a message to the bot to see events`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_SEC * 1_000);

  await runDatafeedLoop({
    client,
    tag: "openclaw-smoke",
    signal: controller.signal,
    handlers: {
      onLog: (m) => console.log(`[datafeed] ${m}`),
      onError: (err) => console.error(`[datafeed] error:`, err),
      onEvent: (envelope) => {
        const message = extractMessageFromEvent(envelope);
        if (!message) {
          console.log(`[event] type=${envelope.type}`);
          return;
        }
        const normalized = normalizeInboundMessage({ message, accountId: "smoke", selfUserId });
        if (!normalized) {
          return;
        }
        console.log(`[message] ${normalized.sender.displayName}: ${normalized.text}`);
        if (normalized.attachments.length > 0) {
          console.log(`  attachments: ${normalized.attachments.map((a) => a.filename).join(", ")}`);
        }
      },
    },
  });
  clearTimeout(timer);
  console.log("[smoke] done");
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}.`);
    process.exit(1);
  }
  return v;
}

main().catch((err) => {
  console.error("[smoke] failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
