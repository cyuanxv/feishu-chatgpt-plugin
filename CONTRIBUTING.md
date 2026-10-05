# Contributing

Run `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, and `npm run build` in your authorized development environment before proposing changes.

Use synthetic fixtures. Keep credentials, private documents and account exports out of the repository. Keep all 30 planned tools in the traceability catalog; only advertise capabilities that actually work. Explain when a test uses a mock rather than a real provider or database.

Do not enable a public listener, live OAuth, new write tools or external data sharing as an incidental refactor. These changes need an explicit design and security review. Never turn the demo account chooser into production authentication.

Dependencies are locked. The initial implementation uses the maintained v1 MCP TypeScript SDK named in the product specification. Reassess its supported release line before production; migration to v2 is a separately tested change.
