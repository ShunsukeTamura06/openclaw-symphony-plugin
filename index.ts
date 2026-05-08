import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { symphonyPlugin } from "./src/plugin.js";
import { setSymphonyRuntime } from "./src/runtime.js";

type ChannelPluginEntry = {
  id: string;
  name: string;
  description: string;
  configSchema: unknown;
  register: (api: unknown) => void;
};

const entry: ChannelPluginEntry = defineChannelPluginEntry({
  id: "symphony",
  name: "Symphony",
  description: "Symphony channel plugin (REST API + Datafeed v2, RSA-JWT bot auth)",
  plugin: symphonyPlugin,
  setRuntime: (runtime) => setSymphonyRuntime(runtime),
}) as unknown as ChannelPluginEntry;

export default entry;
