# Public directory readiness: blocked

As checked on 2026-10-05, the [OpenAI plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines) do not approve plugins primarily acting as unofficial third-party connectors, including pass-through intermediary layers. Proper API access and user OAuth consent are separate requirements, not proof of official connector status. Extra workflows are not a documented exemption.

This independent Feishu integration has not established provider authorization/partnership or public-directory eligibility. No application has been submitted, no review is active and no approval is claimed.

Before preparing a public submission, resolve eligibility with appropriate evidence and the actual review requirements. Also complete:

- Stable authorized HTTPS MCP server, production OAuth and verified domain
- Verified publishing individual/business and the intended OpenAI organization/project
- Public plugin website, support page, accurate privacy policy and terms of service
- Real square icon assets and verified public URLs
- Five positive and three negative test cases executed against the submitted version
- Real reviewer-accessible recording of working behavior
- Dedicated test tenant/account using sample data, delivered through secure reviewer access fields only
- Release notes, supported countries, truthful commerce declarations, security scans and required attestations

The [official submission flow](https://developers.openai.com/plugins/deploy/submission) separates draft upload, review submission and approved publication. A source release, private plugin install or valid ZIP does not imply approval. Only the authorized developer can complete the required identity and legal/policy attestations.

The [developer-mode help article](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) currently distinguishes Pro read/fetch access from Business/Enterprise/Edu full MCP access. Verify actual host/account capabilities; do not treat this statement as a permanent contract or infer the host plan from a tool call.
