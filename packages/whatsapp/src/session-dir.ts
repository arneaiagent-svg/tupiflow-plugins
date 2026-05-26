import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve the on-disk directory where Baileys stores the multi-file auth
 * state for a given WhatsApp integration. Uses `WHATSAPP_SESSION_DIR` when
 * set (recommended for persistent volumes in prod) and falls back to a
 * repo-local path for local development.
 */
export function getWhatsappSessionDir(integrationId: string): string {
  const base =
    process.env.WHATSAPP_SESSION_DIR ||
    join(process.cwd(), "data", "whatsapp-sessions");
  const dir = join(base, integrationId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
