import { homedir } from "node:os";
import { join } from "node:path";

process.env.T3CODE_HOME = process.env.QUI_HOME?.trim() || join(homedir(), ".qui");
process.env.T3CODE_TELEMETRY_ENABLED = "false";
process.env.T3CODE_OTEL_SDK_DISABLED = "true";
process.env.T3CODE_DISABLE_AUTO_UPDATE = "true";

require("./compileCache.cjs");
require("./main.cjs");
