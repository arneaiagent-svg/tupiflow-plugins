import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  extractAttachments,
  extractFileAttachments,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  normalizeMime,
  type IncomingAttachment,
} from "../src/attachments.ts";

function bufOfSize(n: number): Buffer {
  return Buffer.alloc(n, 0x42);
}

test("extractAttachments — 9MB image dropped (cap 8MB)", async () => {
  const buf = bufOfSize(9 * 1024 * 1024);
  const message = {
    attachments: [
      {
        type: "image",
        mimeType: "image/jpeg",
        fetchData: async () => buf,
      } satisfies IncomingAttachment,
    ],
  };
  const out = await extractAttachments(
    message,
    "image",
    MAX_IMAGES_PER_MESSAGE,
    MAX_IMAGE_BYTES,
    "image/jpeg"
  );
  assert.equal(out.length, 0);
});

test("extractAttachments — 5 images with cap 4 → returns 4", async () => {
  const buf = bufOfSize(1024);
  const attachments: IncomingAttachment[] = Array.from({ length: 5 }, () => ({
    type: "image" as const,
    mimeType: "image/jpeg",
    fetchData: async () => buf,
  }));
  const out = await extractAttachments(
    { attachments },
    "image",
    MAX_IMAGES_PER_MESSAGE,
    MAX_IMAGE_BYTES,
    "image/jpeg"
  );
  assert.equal(out.length, 4);
});

test("extractAttachments — fetchData rejection logged + dropped; siblings still processed", async () => {
  const goodBuf = bufOfSize(2048);
  const attachments: IncomingAttachment[] = [
    {
      type: "image",
      mimeType: "image/jpeg",
      fetchData: async () => {
        throw new Error("fetch boom");
      },
    },
    {
      type: "image",
      mimeType: "image/png",
      fetchData: async () => goodBuf,
    },
  ];
  // Swallow the console.warn during the test so the suite output stays clean.
  const origWarn = console.warn;
  console.warn = () => {};
  let out;
  try {
    out = await extractAttachments(
      { attachments },
      "image",
      MAX_IMAGES_PER_MESSAGE,
      MAX_IMAGE_BYTES,
      "image/jpeg"
    );
  } finally {
    console.warn = origWarn;
  }
  assert.equal(out.length, 1);
  assert.equal(out[0].mediaType, "image/png");
});

test("extractAttachments — missing mimeType uses default fallback image/jpeg", async () => {
  const buf = bufOfSize(1024);
  const out = await extractAttachments(
    {
      attachments: [
        {
          type: "image",
          // no mimeType supplied
          fetchData: async () => buf,
        } satisfies IncomingAttachment,
      ],
    },
    "image",
    MAX_IMAGES_PER_MESSAGE,
    MAX_IMAGE_BYTES,
    "image/jpeg"
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].mediaType, "image/jpeg");
  assert.ok(out[0].url.startsWith("data:image/jpeg;base64,"));
});

test("extractAttachments — 0-byte buffer dropped", async () => {
  const out = await extractAttachments(
    {
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          fetchData: async () => Buffer.alloc(0),
        } satisfies IncomingAttachment,
      ],
    },
    "image",
    MAX_IMAGES_PER_MESSAGE,
    MAX_IMAGE_BYTES,
    "image/jpeg"
  );
  assert.equal(out.length, 0);
});

test("extractFileAttachments — missing mimeType uses application/octet-stream fallback", async () => {
  const buf = bufOfSize(1024);
  const out = await extractFileAttachments({
    attachments: [
      {
        type: "file",
        // no mimeType supplied
        fetchData: async () => buf,
      } satisfies IncomingAttachment,
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].mediaType, "application/octet-stream");
});

test("extractFileAttachments — image-type rows are excluded from file bucket", async () => {
  const buf = bufOfSize(1024);
  const out = await extractFileAttachments({
    attachments: [
      {
        type: "image",
        mimeType: "image/png",
        fetchData: async () => buf,
      } satisfies IncomingAttachment,
      {
        type: "file",
        mimeType: "application/pdf",
        fetchData: async () => buf,
      } satisfies IncomingAttachment,
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].mediaType, "application/pdf");
});

test("extractFileAttachments — oversized file (> MAX_FILE_BYTES) dropped", async () => {
  const buf = bufOfSize(MAX_FILE_BYTES + 1);
  const out = await extractFileAttachments({
    attachments: [
      {
        type: "file",
        mimeType: "application/pdf",
        fetchData: async () => buf,
      } satisfies IncomingAttachment,
    ],
  });
  assert.equal(out.length, 0);
});

test("normalizeMime — strips parameters (image/jpeg; charset=utf-8 → image/jpeg)", () => {
  assert.equal(
    normalizeMime("image/jpeg; charset=utf-8", "image/jpeg"),
    "image/jpeg"
  );
});

test("normalizeMime — undefined uses fallback", () => {
  assert.equal(normalizeMime(undefined, "image/png"), "image/png");
});
