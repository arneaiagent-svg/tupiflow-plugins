// Pure body-renderer for the WhatsApp QR overlay. Lives in a .ts (NOT
// .tsx) so node's --experimental-strip-types loader can parse it inside
// the unit-test runtime; React.createElement is used directly instead of
// JSX. The .tsx companion imports + re-exports this helper.

import { createElement as h, type JSX } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";

export interface LinkState {
  connected: boolean;
  error: string | null;
  linkedAs: string | null;
  pairingCode: string | null;
  qrDataUrl: string | null;
}

export function renderBody(
  state: LinkState | null,
  loading: boolean
): JSX.Element {
  if (loading) {
    return h(
      "div",
      {
        className:
          "flex items-center justify-center py-10 text-muted-foreground text-sm",
      },
      h(Loader2, { className: "mr-2 size-4 animate-spin" }),
      "Starting WhatsApp connection…"
    );
  }

  if (state?.connected) {
    return h(
      "div",
      { className: "flex flex-col items-center gap-3 py-8" },
      h(CheckCircle2, { className: "size-12 text-green-600" }),
      h("p", { className: "font-medium" }, "WhatsApp account linked"),
      state.linkedAs
        ? h(
            "p",
            { className: "font-mono text-muted-foreground text-sm" },
            `+${state.linkedAs}`
          )
        : null,
      h(
        "p",
        { className: "text-center text-muted-foreground text-sm" },
        "Incoming messages will now trigger your workflow."
      )
    );
  }

  if (state?.error) {
    return h(
      "div",
      { className: "space-y-3 py-6" },
      h("p", { className: "text-destructive text-sm" }, state.error),
      h(
        "p",
        { className: "text-muted-foreground text-xs" },
        "Close this dialog and reopen the connection to retry."
      )
    );
  }

  if (state?.pairingCode) {
    return h(
      "div",
      { className: "space-y-4 py-4 text-center" },
      h(
        "p",
        { className: "text-sm" },
        "In WhatsApp, open ",
        h(
          "strong",
          null,
          "Settings → Linked Devices → Link a device → Link with phone number instead"
        ),
        " and enter:"
      ),
      h(
        "div",
        { className: "font-mono text-2xl tracking-[0.4em]" },
        state.pairingCode
      ),
      h(
        "p",
        { className: "text-muted-foreground text-xs" },
        "The code expires after about a minute."
      )
    );
  }

  if (state?.qrDataUrl) {
    return h(
      "div",
      { className: "flex flex-col items-center gap-3 py-2" },
      h("img", {
        alt: "WhatsApp linking QR code",
        className: "rounded-md border bg-white p-2",
        height: 256,
        src: state.qrDataUrl,
        width: 256,
      }),
      h(
        "p",
        { className: "text-center text-muted-foreground text-sm" },
        "Open WhatsApp → ",
        h(
          "strong",
          null,
          "Settings → Linked Devices → Link a device"
        ),
        h("br", null),
        "and scan this code. It refreshes automatically."
      )
    );
  }

  return h(
    "div",
    {
      className:
        "flex items-center justify-center py-10 text-muted-foreground text-sm",
    },
    h(Loader2, { className: "mr-2 size-4 animate-spin" }),
    "Waiting for QR code…"
  );
}
