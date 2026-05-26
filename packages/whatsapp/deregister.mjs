import path from "node:path";
import { fileURLToPath } from "node:url";

// Harmonies for terminal output
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";

function logSuccess(msg) {
  console.log(`${GREEN}✔${RESET} ${msg}`);
}

function logInfo(msg) {
  console.log(`${CYAN}ℹ${RESET} ${msg}`);
}

function logError(msg) {
  console.error(`${RED}✘${RESET} ${msg}`);
}

async function run() {
  console.log(`\n${BOLD}${CYAN}WhatsApp Deregistration Tool${RESET}`);
  console.log("=====================================");

  const PLUGIN_NAME = "whatsapp";
  let hostUrl = process.env.TUPIFLOW_API_URL || "http://127.0.0.1:3000";

  const urlArgIndex = process.argv.findIndex(arg => arg === "--url" || arg === "-u");
  if (urlArgIndex !== -1 && process.argv[urlArgIndex + 1]) {
    hostUrl = process.argv[urlArgIndex + 1];
  }

  const endpoint = `${hostUrl.replace(/\/$/, "")}/api/plugins/registry/dev-uninstall`;
  logInfo(`Deregistering ${BOLD}${PLUGIN_NAME}${RESET}...`);
  logInfo(`Uninstall Endpoint: ${BOLD}${endpoint}${RESET}`);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: PLUGIN_NAME,
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

    if (data.status === "uninstalled") {
      logSuccess(`${BOLD}${data.name}@${data.version || "unknown"}${RESET} successfully deregistered.`);
    } else {
      console.log(`${GREEN}Response received:${RESET}`, JSON.stringify(data, null, 2));
    }
  } catch (err) {
    logError(`Deregistration failed: ${err.message}`);
    process.exit(1);
  }
}

run();
