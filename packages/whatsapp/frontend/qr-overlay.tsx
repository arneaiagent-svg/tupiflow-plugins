// whatsapp QR overlay — ported from plugins/whatsapp/frontend/qr-overlay.tsx
// to the registry-plugin frontend extension contract. Host owns the modal
// chrome (overlay shell); this component renders only the body.
//
// Props injected by the host at mount time:
//   integrationId       integration row UUID
//   integrationType?    "whatsapp" — set by the host runtime
//   integration?        the full integration row
//   onClose?            host-supplied close callback
//   onLinked?           host-supplied callback fired when state.connected
//                       first flips to true
//
// HTTP: hits /api/plugins/whatsapp/qr/<id> (GET, poll every 2s) and
// /api/plugins/whatsapp/reset/<id> (POST) directly via fetch().

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from "react";

import { renderBody, type LinkState } from "./qr-overlay-body.ts";

export { renderBody } from "./qr-overlay-body.ts";

export interface WhatsappQrOverlayProps {
  integrationId: string;
  integrationType?: string;
  integration?: {
    id: string;
    name: string;
    type: string;
    createdAt: string;
    updatedAt: string;
  };
  onClose?: () => void;
  onLinked?: () => void;
}

type Notice = { kind: "success" | "error"; message: string } | null;

export function WhatsappQrOverlay({
  integrationId,
  onClose,
  onLinked,
}: WhatsappQrOverlayProps): JSX.Element {
  const [state, setState] = useState<LinkState | null>(null);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const cancelledRef = useRef(false);
  const onLinkedRef = useRef(onLinked);
  const notifiedRef = useRef(false);

  const handleReset = useCallback(async () => {
    try {
      setResetting(true);
      notifiedRef.current = false;
      const res = await fetch(
        `/api/plugins/whatsapp/reset/${encodeURIComponent(integrationId)}`,
        {
          method: "POST",
          credentials: "include",
        }
      );
      if (!res.ok) {
        let detail = "";
        try {
          const body = (await res.json()) as { error?: string };
          detail = body?.error ?? "";
        } catch {
          // ignore
        }
        throw new Error(detail || `Reset failed (HTTP ${res.status})`);
      }
      setState(null);
      setLoading(true);
      setNotice({
        kind: "success",
        message: "Session reset — waiting for new QR code",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to reset session";
      setNotice({ kind: "error", message });
    } finally {
      setResetting(false);
    }
  }, [integrationId]);

  useEffect(() => {
    onLinkedRef.current = onLinked;
  }, [onLinked]);

  useEffect(() => {
    cancelledRef.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const applyResult = (res: LinkState) => {
      setState(res);
      setLoading(false);
      if (res.connected && !notifiedRef.current) {
        notifiedRef.current = true;
        setNotice({ kind: "success", message: "WhatsApp linked" });
        onLinkedRef.current?.();
      }
    };

    const applyError = (error: unknown) => {
      setState({
        connected: false,
        error:
          error instanceof Error ? error.message : "Failed to load QR state",
        linkedAs: null,
        pairingCode: null,
        qrDataUrl: null,
      });
      setLoading(false);
    };

    const poll = async () => {
      try {
        const res = await fetch(
          `/api/plugins/whatsapp/qr/${encodeURIComponent(integrationId)}`,
          { credentials: "include" }
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const body = (await res.json()) as LinkState;
        if (!cancelledRef.current) {
          applyResult(body);
        }
      } catch (error) {
        if (!cancelledRef.current) {
          applyError(error);
        }
      } finally {
        if (!cancelledRef.current) {
          timer = setTimeout(poll, 2000);
        }
      }
    };

    void poll();

    return () => {
      cancelledRef.current = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [integrationId]);

  const connected = !!state?.connected;

  return (
    <div className="space-y-4">
      {notice ? (
        <p
          role="status"
          aria-live="polite"
          className={
            notice.kind === "error"
              ? "text-destructive text-sm"
              : "text-muted-foreground text-sm"
          }
        >
          {notice.message}
        </p>
      ) : null}
      {renderBody(state, loading)}
      <div className="flex justify-end gap-2 pt-2">
        {connected ? (
          <button
            type="button"
            className="rounded-md border px-3 py-1 text-sm"
            onClick={() => onClose?.()}
          >
            Done
          </button>
        ) : (
          <>
            <button
              type="button"
              className="rounded-md border px-3 py-1 text-sm"
              onClick={handleReset}
              disabled={resetting}
            >
              {resetting ? "Resetting…" : "Reset session"}
            </button>
            <button
              type="button"
              className="rounded-md px-3 py-1 text-sm text-muted-foreground"
              onClick={() => onClose?.()}
              disabled={resetting}
            >
              Close
            </button>
          </>
        )}
      </div>
    </div>
  );
}
