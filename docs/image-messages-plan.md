# Image messages: proposal

**Status:** planning only. Image messages are not part of 0.3.2; no upload or attachment API is shipped.

## Proposed first experience

1. Let a user choose an image or paste a screenshot into the composer.
2. Show draft previews with a remove action before sending.
3. Upload through the authenticated chat server to private attachment storage, then send message references rather than inline data or public URLs.
4. Render a thumbnail in chat with a way to open the original.
5. Give agents the actual image payload in a host-supported image block—not a URL placeholder.

Start with PNG, JPEG, and WebP. Do not include SVG, video, or arbitrary file attachments in the first version. Per-image bytes, images per message, and decoded-pixel ceilings are open decisions, not shipped limits.

## Storage and trust

- Use the existing shared-token server access model; do not add a public object URL or remote-URL fetch feature.
- Validate decoded image content and enforce byte and pixel limits before storing or decoding at full size.
- Keep attachment references private and room-scoped. Deleting a room should delete its attachments; also plan cleanup for abandoned uploads.
- Confirm how direct-room access maps to attachment retrieval under the shared-token model.

## Receipt evidence

- Uploading an image or inserting its URL is not evidence that anyone viewed it.
- `displayed` should mean the image preview was actually visible in a focused browser tab.
- `tool` should require the room tool to fetch the referenced image payload, not only message metadata.
- `context` should require the real image payload in the agent's native multimodal context; a URL or textual placeholder does not qualify.

## Before implementation

- Verify the image content shape supported by the installed OpenCode SDK and host before choosing a message/API format.
- Prove with a mock provider that the received context contains image content, not a URL stub.
- Test paste and picker previews, removal, authenticated retrieval, malformed and oversized images, room-deletion cleanup, and each receipt-evidence boundary.
