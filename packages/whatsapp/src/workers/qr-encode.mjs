import QRCode from "qrcode";
import { parentPort } from "node:worker_threads";

if (!parentPort) {
  throw new Error("qr-encode worker must be spawned via worker_threads");
}

parentPort.on("message", async ({ text, margin = 1, scale = 6 }) => {
  try {
    const dataUrl = await QRCode.toDataURL(text, { margin, scale });
    parentPort.postMessage({ ok: true, dataUrl });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: String(error) });
  }
});
