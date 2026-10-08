# Adapter handoff

Use this directory as a standalone Workers/D1 project. The root repository remains the Node/PostgreSQL implementation; its build, tool registration and deployment are unchanged.

The `oai-authenticated-user-id` header is a trust boundary supplied by an authenticated owner-private Sites dispatcher. Never trust an arbitrary internet client's header or expose this bundle on a public raw Worker endpoint.

## Deliberately unconfigured

The hosting manifest contains only `d1: DB`, `r2: null` and the MCP capability. A deployment operator must select/register an authorized project through the supported Sites workflow. There is no usable project identity or deploy credential here.

Runtime values belong in the hosting service, never in source, logs or screenshots:

| Setting | Responsibility |
| --- | --- |
| `APP_ORIGIN` | Exact registered HTTPS origin; `https://your-site.example.invalid` is illustrative only |
| `FEISHU_DATA_MODE` | Use `synthetic` for demonstrations; it rejects OAuth/provider transport |
| `FEISHU_READ_ENABLED` | Real reads require explicit authorized real-mode configuration |
| `FEISHU_APP_ID` | Operator-provided application identifier, absent here |
| `FEISHU_APP_SECRET` | Secure hosting secret, absent here |
| `APP_ENCRYPTION_KEY` | Secure hosting key, absent here; never use sample data as a key |

The callback path is `/api/feishu/callback`, distinct from platform sign-in callbacks. This source does not create apps, add permissions, register credentials or authorize accounts. Do not copy existing grants/databases into this directory.

## Release boundaries

The three D1 migrations describe schema only, without user rows. Apply them only through an authorized deployment process after reviewing the target. Tests use disposable synthetic databases.

Before integration, review platform identity stripping, audience, runtime secrets, provider configuration and rollback; then run appropriate repository CI and real-host acceptance separately. A source-preservation branch is not merge/deployment approval.

Runtime source, schemas, tests and endpoints are preserved. Project registration and private delivery/session narratives are omitted; generic documentation replaces them. Private Git history, runtime files and deployment receipts are excluded.
