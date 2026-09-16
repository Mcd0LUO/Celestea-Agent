/**
 * W804 (multimodal P0 section 3.1): resolve content-addressed image references
 * into a REQUEST-scoped `images` table (attachment_id -> data URL) before the
 * wire layer runs.
 *
 * The bytes are read here, on the request path, and are NEVER persisted: the
 * session log keeps only the reference. A reference whose object is missing is a
 * HARD error — a silently dropped image is worse than a failed request.
 */

import type { Llm, ModelRequest } from "@celestea/core";
import type { AttachmentStore } from "@celestea/tools";

/** Wrap one `Llm` so image references become a data-URL table on the request. */
export function withAttachments(inner: Llm, store: AttachmentStore | null): Llm {
  if (store === null) return inner;
  return {
    async generate(req: ModelRequest) {
      const table: Record<string, string> = {};
      for (const message of req.messages) {
        for (const part of message.content) {
          if (part.type !== "image") continue;
          const id = part.content.attachment_id;
          if (table[id] !== undefined) continue;
          const url = await store.readDataUrl(id);
          if (url === null) {
            throw new Error(`W804: attachment ${id} is not present in ${store.dir}; the image cannot be delivered`);
          }
          table[id] = url;
        }
      }
      if (Object.keys(table).length === 0) return inner.generate(req);
      const withImages: ModelRequest & { images: Record<string, string> } = { ...req, images: table };
      return inner.generate(withImages);
    },
  };
}
