# whatsapp

WhatsApp (Baileys) integration ported from the tupiflow first-party
tree (`tupiflow/plugins/whatsapp/`) to the registry plugin format.
Auth is QR-only (the user scans a code from WhatsApp -> Linked
Devices); pairing-code auth is disabled because the upstream
chat-adapter-baileys issues the request before Baileys' noise
handshake completes and WhatsApp responds with HTTP 428.
