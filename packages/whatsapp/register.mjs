import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, "dist");
const manifestPath = path.join(distPath, "manifest.json");

// Harmonies for terminal output
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

function logSuccess(msg) {
  console.log(`${GREEN}✔${RESET} ${msg}`);
}

function logInfo(msg) {
  console.log(`${CYAN}ℹ${RESET} ${msg}`);
}

function logWarn(msg) {
  console.log(`${YELLOW}⚠${RESET} ${msg}`);
}

function logError(msg) {
  console.error(`${RED}✘${RESET} ${msg}`);
}

async function run() {
  console.log(`\n${BOLD}${CYAN}WhatsApp Registry Tool${RESET}`);
  console.log("=================================");

  if (!fs.existsSync(manifestPath)) {
    logError("manifest.json not found in 'dist' directory!");
    logInfo("Please run 'pnpm build' or 'npm run build' first to generate the build assets.");
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    logError(`Failed to parse manifest.json: ${err.message}`);
    process.exit(1);
  }

  const { name, version } = manifest.identity || {};
  const capabilities = manifest.capabilities || [];

  if (!name || !version) {
    logError("Invalid manifest: missing name or version.");
    process.exit(1);
  }

  logInfo(`Preparing to register ${BOLD}${name}@${version}${RESET}`);
  logInfo(`Plugin Path: ${BOLD}${distPath}${RESET}`);
  logInfo(`Detected Capabilities (${capabilities.length}):`);
  if (capabilities.length > 0) {
    console.log(`  ${YELLOW}${capabilities.join("\n  ")}${RESET}`);
  } else {
    console.log("  (None)");
  }

  // Allow custom URL or port overrides from env or args
  let hostUrl = process.env.TUPIFLOW_API_URL || "http://127.0.0.1:3000";

  // Minimal CLI arg parsing
  const urlArgIndex = process.argv.findIndex(arg => arg === "--url" || arg === "-u");
  if (urlArgIndex !== -1 && process.argv[urlArgIndex + 1]) {
    hostUrl = process.argv[urlArgIndex + 1];
  }

  const endpoint = `${hostUrl.replace(/\/$/, "")}/api/plugins/registry/dev-install`;
  logInfo(`Registering with host endpoint: ${BOLD}${endpoint}${RESET}...`);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: distPath,
        approvedCapabilities: capabilities,
        approvedDeps: Object.keys(manifest.requiredNpmDeps || {}),
      }),
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response from registry: ${text}`);
    }

    if (!res.ok || data.error) {
      const errMsg = data.error?.message || data.error || "Unknown registry error";
      throw new Error(errMsg);
    }

    if (data.status === "installed") {
      logSuccess(`${BOLD}${data.name}@${data.version}${RESET} is successfully registered!`);
      logInfo("Dev-mode live reloads will trigger automatically on future builds.");
    } else {
      console.log(`${GREEN}Response received:${RESET}`, JSON.stringify(data, null, 2));
    }
  } catch (err) {
    logError(`Registration failed: ${err.message}`);
    logInfo("Make sure the Tupiflow local dev server is running on the specified port.");
    logInfo("Usage overrides: node register.mjs --url http://127.0.0.1:3000");
    process.exit(1);
  }
}

run();
