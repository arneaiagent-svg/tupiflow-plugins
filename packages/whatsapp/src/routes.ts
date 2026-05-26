// whatsapp routes — QR / status + reset endpoints. Ported from
// plugins/whatsapp/route.ts to consume the registry-plugin host API:
// auth via `ctx.abilities` instead of `requireAbility`; QR encoding via
// `api.runTask("whatsapp-qr-encode", ...)`; instance restart via the
// optional `api.connections.restart` shim surface (feature-detected
// because the host typed it as `restart?`).

import { rmSync } from "node:fs";
import postgres from "postgres";

import type {
  BaileysAdapter,
} from "chat-adapter-baileys";
import type { Chat } from "chat";

import type {
  PluginHostAPI,
  RouteContext,
  RouteHandler,
} from "@tupiflow-plugins/shared/host-api-types";

import { getWhatsappLinkState, type WhatsappLinkState } from "./link-state.ts";
import { getWhatsappSessionDir } from "./session-dir.ts";

// Defense-in-depth: integrationId arrives via path param. Validate the format
// before using it as a directory name or DB key prefix to block `..`, `/`, or
// other traversal/injection attempts. Host's RBAC gate is authoritative for
// ownership; this regex blocks malformed IDs that the auth gate would let
// through if the row id was somehow attacker-controlled.
const INTEGRATION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function assertValidIntegrationId(
  ctx: RouteContext,
  integrationId: string
): unknown | undefined {
  if (!INTEGRATION_ID_RE.test(integrationId)) {
    return ctx.json({ error: "Invalid integrationId" }, 400);
  }
  return undefined;
}

export interface WhatsappInstance {
  adapter: BaileysAdapter;
  chat: Chat;
  state: WhatsappLinkState;
}

export type InstanceRegistry = {
  get(integrationId: string): WhatsappInstance | undefined;
  set(integrationId: string, instance: WhatsappInstance): void;
  delete(integrationId: string): void;
};

export function createInstanceRegistry(): InstanceRegistry {
  const map = new Map<string, WhatsappInstance>();
  return {
    get: (id) => map.get(id),
    set: (id, instance) => {
      map.set(id, instance);
    },
    delete: (id) => {
      map.delete(id);
    },
  };
}

const CHAT_STATE_TABLES = [
  "chat_state_subscriptions",
  "chat_state_locks",
  "chat_state_cache",
  "chat_state_lists",
  "chat_state_queues",
] as const;

export async function wipeChatStateForIntegration(
  integrationId: string
): Promise<void> {
  const chatStateUrl = process.env.CONNECTION_CHAT_DATABASE_URL;
  if (!chatStateUrl) {
    return;
  }
  const keyPrefix = `whatsapp:${integrationId}`;
  const sql = postgres(chatStateUrl, { max: 1 });
  try {
    for (const table of CHAT_STATE_TABLES) {
      await sql`DELETE FROM ${sql(table)} WHERE key_prefix = ${keyPrefix}`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export interface RouteDeps {
  api: PluginHostAPI;
  registry: InstanceRegistry;
}

/**
 * Tenant-scoped ownership check. `api.integrations.list({type})` returns rows
 * owned by the caller's resolved userId only — cross-tenant rows are never
 * returned. If `integrationId` is not in the result, the caller does not own
 * the row (or it does not exist). Returns true when owned, false otherwise.
 *
 * Used by reset to gate destructive cleanup BEFORE wiping the on-disk session
 * directory and chat-state rows. Without this gate, a caller with the
 * `update:Integration` ability could guess any integrationId and wipe a
 * foreign tenant's WhatsApp session state before `api.connections.restart`
 * surfaces the 403.
 */
async function callerOwnsIntegration(
  api: PluginHostAPI,
  integrationId: string
): Promise<boolean> {
  try {
    const rows = await api.integrations.list({ type: "whatsapp" });
    return rows.some((r) => r.id === integrationId);
  } catch (error) {
    console.warn("[whatsapp] integrations.list failed:", error);
    return false;
  }
}

type QrWorkerOutput = { ok: boolean; dataUrl?: string; error?: string };

/**
 * GET /qr/:integrationId — returns the live link state (QR data URL, linked
 * account identity, or error). Polled every 2s by the frontend overlay.
 */
export function makeWhatsappQrHandler(deps: RouteDeps): RouteHandler {
  const { api } = deps;
  return async (ctx) => {
    if (
      !ctx.abilities.includes("read:Integration") &&
      !ctx.abilities.includes("update:Integration")
    ) {
      return ctx.json({ error: "forbidden" }, 403);
    }
    const integrationId = ctx.req.param("integrationId");
    if (!integrationId) {
      return ctx.json({ error: "missing integrationId" }, 400);
    }
    const bad = assertValidIntegrationId(ctx, integrationId);
    if (bad) return bad;
    try {
      const state = getWhatsappLinkState(integrationId);
      if (!state) {
        return ctx.json({
          connected: false,
          error: "Connection not running. Refresh or reopen settings.",
          linkedAs: null,
          pairingCode: null,
          qrDataUrl: null,
        });
      }
      let qrDataUrl: string | null = null;
      if (state.qr) {
        const out = (await api.runTask("whatsapp-qr-encode", {
          text: state.qr,
          margin: 1,
          scale: 6,
        })) as QrWorkerOutput;
        if (out?.ok) {
          qrDataUrl = out.dataUrl ?? null;
        }
      }
      return ctx.json({
        connected: state.connected,
        error: state.error,
        linkedAs: state.linkedAs,
        pairingCode: state.pairingCode,
        qrDataUrl,
      });
    } catch (error) {
      console.error("[whatsapp] failed to read QR state:", error);
      return ctx.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to read WhatsApp QR state",
        },
        500
      );
    }
  };
}

/**
 * POST /reset/:integrationId — tears down the live instance, wipes the
 * on-disk Baileys session + the chat-state rows, and re-spawns via
 * `api.connections.restart`. The restart surface is typed optional on the
 * host shim (`restart?`); feature-detect and surface a clear error so an
 * older host doesn't crash with a TypeError.
 */
export function makeWhatsappResetHandler(deps: RouteDeps): RouteHandler {
  const { api } = deps;
  return async (ctx) => {
    if (!ctx.abilities.includes("update:Integration")) {
      return ctx.json({ error: "forbidden" }, 403);
    }
    const integrationId = ctx.req.param("integrationId");
    if (!integrationId) {
      return ctx.json({ error: "missing integrationId" }, 400);
    }
    const bad = assertValidIntegrationId(ctx, integrationId);
    if (bad) return bad;

    if (!(await callerOwnsIntegration(api, integrationId))) {
      return ctx.json({ error: "Integration not found" }, 404);
    }

    const restart =
      api.connections && typeof api.connections.restart === "function"
        ? api.connections.restart.bind(api.connections)
        : undefined;
    if (!restart) {
      return ctx.json(
        {
          error:
            "host missing api.connections.restart — upgrade tupiflow",
        },
        500
      );
    }

    try {
      // Best-effort: wipe the on-disk session directory + chat-state rows
      // BEFORE asking the host to restart. The host's restart() does NOT
      // own these side effects (see HANDOFF_HOST_CONNECTION_RESTART_SURFACE).
      try {
        const sessionDir = getWhatsappSessionDir(integrationId);
        rmSync(sessionDir, { recursive: true, force: true });
      } catch (error) {
        console.warn("[whatsapp] session dir wipe failed:", error);
      }
      try {
        await wipeChatStateForIntegration(integrationId);
      } catch (error) {
        console.warn("[whatsapp] chat-state wipe failed:", error);
      }

      await restart(integrationId);
      return ctx.json({ success: true });
    } catch (error) {
      const name = (error as { name?: string })?.name ?? "";
      if (name === "IntegrationOwnershipError") {
        return ctx.json({ error: "forbidden" }, 403);
      }
      console.error("[whatsapp] failed to reset session:", error);
      return ctx.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to reset WhatsApp session",
        },
        500
      );
    }
  };
}
