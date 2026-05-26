export interface WhatsappLinkState {
  connected: boolean;
  error: string | null;
  linkedAs: string | null;
  linkedAt: number | null;
  pairingCode: string | null;
  qr: string | null;
}

const globalForLink = globalThis as unknown as {
  __whatsappLinkStates?: Map<string, WhatsappLinkState>;
};

export function getLinkStates(): Map<string, WhatsappLinkState> {
  if (!globalForLink.__whatsappLinkStates) {
    globalForLink.__whatsappLinkStates = new Map();
  }
  return globalForLink.__whatsappLinkStates;
}

export function getWhatsappLinkState(
  integrationId: string
): WhatsappLinkState | undefined {
  return getLinkStates().get(integrationId);
}
