// whatsapp — SDK-based registry plugin port of plugins/whatsapp.
// Uses chat-adapter-baileys + chat SDK for QR-based linking, inbound
// message routing, and outbound replies. QR is served via the
// /api/plugins/whatsapp/qr/:integrationId route and rendered by a
// React overlay declared in manifest.integrationRowActions.

import type { PluginHostAPI } from "@tupiflow-plugins/shared/host-api-types";

import { buildWhatsappThreadJson, makeStartInstance } from "./connection.ts";
import {
  createInstanceRegistry,
  makeWhatsappQrHandler,
  makeWhatsappResetHandler,
} from "./routes.ts";
import { runSendReply, type SendReplyInput } from "./send-reply.ts";
import { testWhatsapp } from "./test.ts";

export function registerPlugin(api: PluginHostAPI): void {
  const registry = createInstanceRegistry();

  api.registerIntegration({
    type: "whatsapp",
    label: "WhatsApp",
    formFields: [],
    actions: [
      {
        slug: "send-reply",
        label: "Send WhatsApp Reply",
        description: "Reply to the incoming WhatsApp thread",
        category: "WhatsApp",
        stepFunction: "whatsappSendReplyStep",
      },
    ],
  });

  api.registerTestHandler(async () => testWhatsapp());

  api.registerStep("whatsappSendReplyStep", async (input: unknown) =>
    runSendReply(input as SendReplyInput, { api, registry })
  );

  api.registerConnection({
    startInstance: makeStartInstance({ api, registry }),
    buildThreadJson: buildWhatsappThreadJson,
  });

  api.registerRoute(
    "GET",
    "/qr/:integrationId",
    makeWhatsappQrHandler({ api, registry })
  );
  api.registerRoute(
    "POST",
    "/reset/:integrationId",
    makeWhatsappResetHandler({ api, registry })
  );
}
