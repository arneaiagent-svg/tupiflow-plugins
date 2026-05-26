// WhatsApp "test connection" is a no-op. Baileys has no lightweight probe
// like Telegram's `getMe` — linking happens through the QR flow after the
// integration is created, and live status is reported by the dedicated
// `GET /api/plugins/whatsapp/qr/:integrationId` endpoint.

import type { TestIntegrationResult } from "@tupiflow-plugins/shared/host-api-types";

export function testWhatsapp(): Promise<TestIntegrationResult> {
  return Promise.resolve({ success: true });
}
