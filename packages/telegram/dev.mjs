import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawn } from "node:child_process";

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

// Config
const PLUGIN_NAME = "telegram";
let hostUrl = process.env.TUPIFLOW_API_URL || "http://127.0.0.1:3000";

// Command-line overrides
const urlArgIndex = process.argv.findIndex(arg => arg === "--url" || arg === "-u");
if (urlArgIndex !== -1 && process.argv[urlArgIndex + 1]) {
  hostUrl = process.argv[urlArgIndex + 1];
}

const cleanHostUrl = hostUrl.replace(/\/$/, "");
const uninstallEndpoint = `${cleanHostUrl}/api/plugins/registry/dev-uninstall`;
const installEndpoint = `${cleanHostUrl}/api/plugins/registry/dev-install`;

async function uninstallPlugin() {
  logInfo("Deregistering any existing installation...");
  try {
    const res = await fetch(uninstallEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: PLUGIN_NAME }),
    });
    
    if (res.status === 200) {
      logSuccess("Deregistration complete (starting clean).");
    } else {
      const txt = await res.text();
      // If it wasn't installed, that's fine, ignore error
      if (!txt.includes("not found") && !txt.includes("not installed")) {
        logWarn(`Uninstall status: ${res.status}. Response: ${txt}`);
      }
    }
  } catch (err) {
    logWarn(`Could not deregister (is server running?): ${err.message}`);
  }
}

function buildPlugin() {
  logInfo("Building plugin...");
  try {
    execSync("node build.mjs", { stdio: "inherit", cwd: __dirname });
    logSuccess("Build complete.");
    return true;
  } catch (err) {
    logError(`Build failed: ${err.message}`);
    return false;
  }
}

async function installPlugin() {
  if (!fs.existsSync(manifestPath)) {
    logError("manifest.json not found! Cannot register.");
    return false;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    logError(`Failed to parse manifest.json: ${err.message}`);
    return false;
  }

  const { name, version } = manifest.identity || {};
  const capabilities = manifest.capabilities || [];

  logInfo(`Registering ${BOLD}${name}@${version}${RESET} with capabilities...`);
  try {
    const res = await fetch(installEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: distPath,
        approvedCapabilities: capabilities,
        approvedDeps: Object.keys(manifest.requiredNpmDeps || {}),
      }),
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error?.message || data.error || "Registry error");
    }

    logSuccess(`${BOLD}${data.name}@${data.version}${RESET} successfully registered!`);
    return true;
  } catch (err) {
    logError(`Registration failed: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log(`\n${BOLD}${CYAN}Telegram Interactive Dev Env${RESET}`);
  console.log("=====================================");

  // 1. Uninstall/Deregister
  await uninstallPlugin();

  // 2. Build once
  if (!buildPlugin()) {
    process.exit(1);
  }

  // 3. Register/Install
  if (!(await installPlugin())) {
    process.exit(1);
  }

  // 4. Start watcher
  logInfo("Starting build watcher...");
  console.log(`\n${YELLOW}--- WATCHER OUTPUT START ---${RESET}`);
  
  const watcher = spawn("node", ["build.mjs", "--watch"], {
    stdio: "inherit",
    cwd: __dirname,
  });

  // Handle Ctrl+C / Termination
  const cleanup = async () => {
    console.log(`\n\n${YELLOW}--- TERMINATING DEV ENV ---${RESET}`);
    watcher.kill();
    await uninstallPlugin();
    logInfo("Exiting. Have a great day!");
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  logError(`Fatal error: ${err.message}`);
  process.exit(1);
});
