{
  "id": "5ef6b3ef",
  "title": "Handle quoted/space-containing paths in push-bundle args",
  "tags": [
    "pi",
    "extension",
    "bug",
    "P2"
  ],
  "status": "open",
  "created_at": "2026-02-04T06:49:37.546Z"
}

Issue: .pi/extensions/push-bundle.ts splits args on whitespace, breaking bundle/epub paths with spaces.

Fix: Use a proper argv parser (e.g., string-argv) or a simple quoted-arg parser; preserve quoted paths.

Reference: args parsing in push-bundle command handler (.pi/extensions/push-bundle.ts).
