import type { ChatAttachment } from "@tupiflow-plugins/shared/host-api-types";

export const MAX_IMAGES_PER_MESSAGE = 4;
export const MAX_FILES_PER_MESSAGE = 4;
export const MAX_AUDIO_PER_MESSAGE = 2;
export const MAX_VIDEOS_PER_MESSAGE = 2;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

export interface IncomingAttachment {
  fetchData?: () => Promise<Buffer>;
  mimeType?: string;
  name?: string;
  type: "image" | "file" | "video" | "audio";
}

export function normalizeMime(
  raw: string | undefined,
  fallback: string
): string {
  const base = (raw || fallback).split(";")[0]?.trim().toLowerCase();
  return base || fallback;
}

export async function extractAttachments(
  message: { attachments?: IncomingAttachment[] },
  kind: "image" | "file" | "audio" | "video",
  limit: number,
  maxBytes: number,
  defaultMime: string
): Promise<ChatAttachment[]> {
  const attachments = message.attachments ?? [];
  const matched = attachments
    .filter((a) => a.type === kind && typeof a.fetchData === "function")
    .slice(0, limit);
  const out: ChatAttachment[] = [];
  for (const att of matched) {
    try {
      const buf = await att.fetchData?.();
      if (!buf || buf.byteLength === 0 || buf.byteLength > maxBytes) {
        continue;
      }
      const mime = normalizeMime(att.mimeType, defaultMime);
      out.push({
        url: `data:${mime};base64,${buf.toString("base64")}`,
        filename: att.name,
        mediaType: mime,
      });
    } catch (error) {
      console.warn(`[whatsapp] failed to fetch ${kind} attachment:`, error);
    }
  }
  return out;
}

export async function extractFileAttachments(message: {
  attachments?: IncomingAttachment[];
}): Promise<ChatAttachment[]> {
  const attachments = message.attachments ?? [];
  const files = attachments
    .filter(
      (a) =>
        a.type !== "image" &&
        a.type !== "audio" &&
        a.type !== "video" &&
        typeof a.fetchData === "function"
    )
    .slice(0, MAX_FILES_PER_MESSAGE);
  const out: ChatAttachment[] = [];
  for (const att of files) {
    try {
      const buf = await att.fetchData?.();
      if (!buf || buf.byteLength === 0 || buf.byteLength > MAX_FILE_BYTES) {
        continue;
      }
      const mime = normalizeMime(att.mimeType, "application/octet-stream");
      out.push({
        url: `data:${mime};base64,${buf.toString("base64")}`,
        filename: att.name,
        mediaType: mime,
      });
    } catch (error) {
      console.warn("[whatsapp] failed to fetch file attachment:", error);
    }
  }
  return out;
}
