# Higgsfield MCP Gateway

**Production Specification**  
Version: `0.1.0`  
Status: Production Architecture / Implementation Ready  
Runtime: Node.js + TypeScript  
Protocol: MCP 2026-07-28+  
Primary Provider: Higgsfield API

---

# 1. Product Vision

Higgsfield MCP Gateway is a production-ready Model Context Protocol server that exposes Higgsfield's generative media capabilities to MCP-compatible AI agents.

The project combines:

1. **Higgsfield API** — execution layer.
2. **MCP tools/resources** — standardized agent interface.
3. **Higgsfield-compatible Skills** — creative knowledge, decision trees, model routing, and multi-step workflows.
4. **Agent hosts** — planning, reasoning, subagents, delegation, and orchestration.

The gateway MUST NOT implement its own general-purpose agent framework.

Its responsibility is to make Higgsfield capabilities reliable, discoverable, safe, observable, and easy for agents to invoke.

```text
┌─────────────────────────────────────────────┐
│                Agent Hosts                  │
│                                             │
│ Codex / Claude / Cursor / Pi / Custom Agent │
└─────────────────────┬───────────────────────┘
                      │
              Skills / Reasoning
                      │
                      ▼
┌─────────────────────────────────────────────┐
│          Higgsfield MCP Gateway             │
│                                             │
│ Tools                                       │
│ Resources                                   │
│ Model Registry                              │
│ Job Manager                                 │
│ Media Manager                               │
│ Cost / Policy Layer                         │
│ Observability                               │
└─────────────────────┬───────────────────────┘
                      │
                      ▼
             Higgsfield API / SDK
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
     Image Models             Video Models
     Audio / 3D              Creative APIs
```

---

# 2. Core Principles

## 2.1 MCP is capability, not intelligence

The MCP server provides reliable operations.

It SHOULD NOT decide the complete creative workflow.

Example:

```text
Skill:
"Create product campaign"

        ↓ decides workflow

product image
        ↓
video animation
        ↓
variant generation
        ↓
final assets

MCP:
executes each operation
```

---

## 2.2 Skills own creative decision making

Skills determine:

- workflow stages;
- model selection;
- prompt strategy;
- reference-image strategy;
- when another skill should be invoked;
- when user approval is required;
- quality/cost tradeoffs;
- retry or refinement strategy.

MCP tools execute those decisions.

---

## 2.3 Provider details remain accessible

The system MUST support both:

### Semantic interface

```text
generate_image()
generate_video()
edit_image()
animate_image()
```

for agents that do not need provider details.

### Provider-native interface

```text
generate({
  endpoint,
  input
})
```

for advanced Higgsfield skills requiring exact model capabilities.

Neither interface replaces the other.

---

## 2.4 Asynchronous by design

Image/video generation MUST be treated as asynchronous work.

No architecture component may assume generation completes during one short HTTP request.

---

## 2.5 Provider isolation

All Higgsfield-specific implementation MUST live behind a provider interface.

Future providers SHOULD be addable without changing MCP contracts.

```text
MCP Tool
   ↓
Capability Service
   ↓
Provider Adapter
   ↓
Higgsfield
```

---

# 3. Goals

The project MUST:

- expose Higgsfield generation through MCP;
- support local and remote MCP clients;
- provide image, video, audio, editing, and supported media capabilities;
- handle long-running generation jobs;
- upload local/reference media safely;
- expose model capabilities and schemas;
- support Higgsfield Skills;
- allow skills to chain capabilities;
- preserve advanced model-specific options;
- support cost-aware workflows;
- provide structured errors agents can reason about;
- support Docker deployment;
- support npm/npx execution;
- provide production logging and metrics;
- avoid leaking API credentials;
- remain independent from any particular agent host.

---

# 4. Non-Goals

The project will NOT initially provide:

- general multi-agent orchestration;
- its own LLM;
- its own chat UI;
- workflow scheduling platform;
- media editor UI;
- replacement for Higgsfield;
- automatic publishing to social networks;
- arbitrary shell execution;
- generic website deployment;
- distributed workflow engine.

Agent-to-agent delegation belongs to the host.

---

# 5. Technology Stack

## Runtime

```text
Node.js >= 22
TypeScript
ESM
```

## Core

```text
@modelcontextprotocol/server
@higgsfield/client
zod
pino
```

## HTTP mode

Recommended lightweight stack:

```text
Hono or Fastify
```

HTTP framework MUST remain transport infrastructure only.

Business logic MUST NOT live inside route handlers.

## Testing

```text
Vitest
MSW / HTTP mocks
Testcontainers where necessary
```

## Optional production services

```text
Redis
PostgreSQL
S3 / Cloudflare R2
OpenTelemetry
Prometheus
```

They MUST NOT be mandatory for local stdio operation.

---

# 6. MCP Transport

Two transports MUST be supported.

## Local

```text
stdio
```

Example:

```bash
npx higgsfield-mcp
```

Suitable for:

- Codex;
- Claude Code;
- Cursor;
- Pi;
- local development.

## Remote

```text
Streamable HTTP
```

Example:

```text
POST /mcp
```

Remote mode MUST support:

- authentication;
- sessions where required;
- request limits;
- health endpoints;
- graceful shutdown.

Legacy HTTP+SSE SHOULD NOT be used for new deployments.

---

# 7. Repository Architecture

```text
higgsfield-mcp/
│
├── apps/
│   └── server/
│       ├── src/
│       └── package.json
│
├── packages/
│
│   ├── core/
│   │   ├── capabilities/
│   │   ├── jobs/
│   │   ├── media/
│   │   ├── models/
│   │   ├── errors/
│   │   └── policies/
│   │
│   ├── provider-higgsfield/
│   │   ├── client/
│   │   ├── adapters/
│   │   ├── schemas/
│   │   ├── models/
│   │   └── errors/
│   │
│   ├── mcp/
│   │   ├── tools/
│   │   ├── resources/
│   │   ├── prompts/
│   │   └── server/
│   │
│   ├── skills/
│   │   ├── source/
│   │   ├── patches/
│   │   ├── generated/
│   │   └── registry/
│   │
│   ├── observability/
│   ├── config/
│   └── shared/
│
├── skills/
│   ├── higgsfield-generate/
│   ├── higgsfield-soul-id/
│   ├── higgsfield-product-photoshoot/
│   ├── higgsfield-brandkit/
│   ├── higgsfield-marketplace-cards/
│   ├── higgsfield-video-explainer/
│   ├── higgsfield-youtube-thumbnail/
│   └── ...
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── contract/
│   └── e2e/
│
├── scripts/
├── docs/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

Use a monorepo from the beginning.

---

# 8. Layer Architecture

```text
MCP Transport
      │
      ▼
Tool Handler
      │
      ▼
Capability Service
      │
      ├── validation
      ├── policy
      ├── cost guard
      └── job creation
              │
              ▼
       Provider Adapter
              │
              ▼
       Higgsfield SDK/API
```

Tool handlers MUST remain thin.

They MUST NOT contain provider business logic.

---

# 9. Provider Contract

Define a generic provider interface.

```ts
interface MediaProvider {
  generate(
    request: GenerationRequest
  ): Promise<GenerationJob>;

  getJob(
    id: string
  ): Promise<GenerationJob>;

  cancelJob(
    id: string
  ): Promise<void>;

  uploadMedia(
    input: MediaInput
  ): Promise<MediaAsset>;

  getModels(): Promise<ModelDefinition[]>;

  getModel(
    id: string
  ): Promise<ModelDefinition>;

  estimateCost?(
    request: GenerationRequest
  ): Promise<CostEstimate>;
}
```

Initial implementation:

```text
HiggsfieldProvider
```

Future implementations MAY include other providers without changing MCP tools.

---

# 10. Tool Design

Tools are divided into four groups.

---

# 10.1 Semantic Generation Tools

These SHOULD be preferred by generic agents.

## `higgsfield.generate_image`

Purpose:

Generate a new image.

Input:

```ts
{
  prompt: string

  negative_prompt?: string

  aspect_ratio?: string

  width?: number
  height?: number

  quality?: "draft" | "standard" | "high"

  style?: string

  reference_images?: MediaReference[]

  model?: string

  seed?: number

  count?: number

  wait?: boolean
}
```

Output:

```ts
{
  job_id: string
  status: JobStatus

  model: string

  assets?: MediaAsset[]

  cost?: CostInfo

  metadata: {}
}
```

---

## `higgsfield.edit_image`

```ts
{
  prompt: string

  image: MediaReference

  mask?: MediaReference

  references?: MediaReference[]

  model?: string

  preserve_identity?: boolean

  aspect_ratio?: string

  wait?: boolean
}
```

---

## `higgsfield.generate_video`

```ts
{
  prompt: string

  start_image?: MediaReference
  end_image?: MediaReference

  references?: MediaReference[]

  duration?: number

  aspect_ratio?: string

  resolution?: string

  audio?: boolean

  model?: string

  quality?: string

  wait?: boolean
}
```

---

## `higgsfield.animate_image`

Specialized image-to-video abstraction.

```ts
{
  image: MediaReference

  prompt: string

  duration?: number

  motion_strength?: string

  camera_motion?: string

  model?: string

  wait?: boolean
}
```

---

## `higgsfield.generate_audio`

Expose when supported by the provider catalog.

---

# 10.2 Advanced Provider Tools

## `higgsfield.generate`

Provides direct endpoint access.

```ts
{
  endpoint: string

  input: Record<string, unknown>

  wait?: boolean

  webhook?: {
    url: string
  }
}
```

This tool MUST NOT bypass:

- authentication;
- endpoint allowlists;
- input validation where available;
- policy enforcement;
- logging;
- cost guards.

---

# 10.3 Discovery Tools

## `higgsfield.models.list`

```ts
{
  type?: "image" | "video" | "audio" | "3d"
  capability?: string
}
```

---

## `higgsfield.models.get`

```ts
{
  model: string
}
```

Returns:

```ts
{
  id
  name
  type
  capabilities
  input_schema
  limits
  pricing
}
```

---

## `higgsfield.capabilities`

Returns gateway capabilities.

Agents SHOULD be able to inspect the gateway instead of relying entirely on static knowledge.

---

# 10.4 Job Tools

## `higgsfield.jobs.get`

```ts
{
  job_id: string
}
```

## `higgsfield.jobs.wait`

```ts
{
  job_id: string

  timeout_ms?: number
}
```

The server MUST impose its own maximum wait duration.

## `higgsfield.jobs.cancel`

```ts
{
  job_id: string
}
```

## `higgsfield.jobs.list`

Optional for remote/persistent deployments.

---

# 11. Job Model

Canonical internal representation:

```ts
type JobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";
```

```ts
interface GenerationJob {
  id: string;

  provider: string;
  providerJobId?: string;

  capability: string;
  model?: string;

  status: JobStatus;

  progress?: number;

  createdAt: string;
  updatedAt: string;

  inputSummary: Record<string, unknown>;

  assets: MediaAsset[];

  cost?: CostInfo;

  error?: StructuredError;
}
```

Never expose credentials or sensitive request headers through job metadata.

---

# 12. Async Execution Strategy

Default behavior:

```text
tool call
   ↓
submit job
   ↓
return job_id immediately
```

Agent:

```text
jobs.get(job_id)
```

or:

```text
jobs.wait(job_id)
```

For fast image operations:

```text
wait=true
```

MAY allow synchronous-style execution.

Video operations SHOULD default to:

```text
wait=false
```

This prevents MCP transport timeout problems.

---

# 13. Idempotency

Generation calls SHOULD accept:

```text
idempotency_key
```

The gateway MUST prevent accidental duplicate expensive generation when the same operation is retried.

Recommended key scope:

```text
tenant
+
tool
+
idempotency_key
```

---

# 14. Media Architecture

Agents frequently operate on:

- local files;
- URLs;
- previously generated assets;
- MCP resources;
- data URIs.

Canonical representation:

```ts
type MediaReference =
  | {
      type: "url";
      url: string;
    }
  | {
      type: "asset";
      asset_id: string;
    }
  | {
      type: "file";
      path: string;
    };
```

---

# 15. Media Tools

## `higgsfield.media.upload`

```ts
{
  source:
    | { path: string }
    | { url: string }

  media_type?: "image" | "video" | "audio"
}
```

Returns:

```ts
{
  asset_id: string
  url: string
  media_type: string
  mime_type: string
  size: number
}
```

---

## `higgsfield.media.get`

Returns asset metadata.

---

# 16. Local File Security

Local file access is dangerous.

The server MUST NOT accept unrestricted filesystem paths.

Configuration:

```env
HF_MCP_ALLOWED_PATHS=/workspace,/tmp/higgsfield
```

A request outside these directories MUST fail.

Prevent:

```text
../../etc/passwd

~/.ssh/id_rsa

/proc/*

/var/run/docker.sock
```

Symlink traversal MUST also be checked.

---

# 17. Remote URL Security

Media downloading MUST protect against SSRF.

Block:

```text
localhost
127.0.0.0/8
169.254.0.0/16
RFC1918 networks
metadata endpoints
file://
ftp://
```

Allow:

```text
https://
```

HTTP MAY be disabled by default.

Enforce:

```text
maximum file size
download timeout
redirect limit
MIME validation
```

---

# 18. Asset Storage

Two modes:

## Passthrough

Return provider asset URLs.

Suitable for local use.

## Managed

Download generated assets into configured object storage.

```text
Higgsfield
    ↓
Gateway
    ↓
R2 / S3
```

Configuration:

```env
HF_MCP_ASSET_MODE=passthrough|managed
```

Managed mode SHOULD be recommended for production.

---

# 19. Model Registry

Do not hardcode model selection throughout the application.

Create centralized:

```text
ModelRegistry
```

Example:

```ts
interface ModelDefinition {
  id: string;

  provider: "higgsfield";

  type:
    | "image"
    | "video"
    | "audio"
    | "3d";

  capabilities: string[];

  inputSchema?: object;

  pricing?: PricingDefinition;

  status:
    | "active"
    | "deprecated"
    | "experimental";
}
```

---

# 20. Model Aliases

Skills SHOULD prefer semantic aliases when exact models are unnecessary.

Example:

```text
image.default
image.high_quality
image.fast

video.default
video.high_quality
video.fast

image.edit
image.identity

audio.default
```

Resolution occurs inside ModelRegistry.

Example:

```text
video.high_quality
       ↓
configured Higgsfield model
```

Aliases MUST be configurable.

This protects skills from model churn.

---

# 21. Skills Architecture

The repository SHOULD maintain Higgsfield-compatible skills separately from MCP implementation.

```text
skills/
  higgsfield-generate/
    SKILL.md
    references/

  higgsfield-soul-id/
    SKILL.md
    references/

  ...
```

Skills MUST remain usable independently where practical.

---

# 22. Upstream Skill Strategy

Do NOT manually fork skills and permanently diverge.

Use:

```text
Upstream
higgsfield-ai/skills
       ↓
sync
       ↓
source/
       ↓
adapter patches
       ↓
generated MCP-compatible skills
```

Repository:

```text
packages/skills/
├── source/
├── patches/
├── generated/
└── manifest.json
```

---

# 23. Skill Patch Philosophy

Change only execution instructions.

Example upstream:

```text
higgsfield generate create ...
```

Adapter version:

```text
Use MCP tool:
higgsfield.generate
```

Preserve whenever possible:

- creative workflow;
- model guidance;
- decision trees;
- prompt engineering;
- approval checkpoints;
- quality guidance;
- troubleshooting knowledge.

---

# 24. Skill Compatibility Layer

Each patched skill SHOULD declare:

```yaml
x-higgsfield-mcp:
  required: true
  minimum-version: 0.1.0
  tools:
    - higgsfield.generate
    - higgsfield.jobs.get
    - higgsfield.media.upload
```

A validation script MUST ensure referenced tools exist.

---

# 25. Skill Sync

Provide:

```bash
pnpm skills:sync
```

Process:

```text
fetch upstream
      ↓
verify version
      ↓
copy source
      ↓
apply patches
      ↓
validate references
      ↓
validate tool names
      ↓
run skill tests
      ↓
generated/
```

CI MUST detect upstream changes.

It SHOULD NOT automatically merge changed skills into a release.

Instead:

```text
new upstream version
       ↓
CI alert
       ↓
compatibility PR
       ↓
tests
       ↓
human review
```

---

# 26. Initial Skill Support

P0:

```text
higgsfield-generate
higgsfield-soul-id
higgsfield-product-photoshoot
```

P1:

```text
higgsfield-brandkit
higgsfield-marketplace-cards
higgsfield-video-explainer
higgsfield-youtube-thumbnail
```

`higgsfield-websites` SHOULD initially remain outside core scope because it involves a broader deployment/runtime surface than media generation.

---

# 27. Skill Chaining

Skills MAY reference other skills.

Example:

```text
product campaign
      │
      ├── product-photoshoot
      │
      ▼
generate product image
      │
      ▼
higgsfield-generate
      │
      ▼
animate image
```

The MCP server does NOT orchestrate this chain.

The agent host executes the workflow described by the skills.

---

# 28. Agent Collaboration

The gateway MUST be compatible with agent hosts that support subagents.

Example:

```text
Creative Director Agent
        │
        ├───────────────┐
        ▼               ▼
 Image Agent        Video Agent
        │               │
        └───────┬───────┘
                ▼
       Higgsfield MCP
```

All agents MAY connect to the same gateway.

The gateway SHOULD NOT assume:

```text
which agent is supervisor
which agent owns planning
how agents communicate
```

---

# 29. Workspace Context

For collaborative workflows, MCP calls MAY include:

```text
workspace_id
```

Example:

```ts
{
  workspace_id: "campaign-42",
  prompt: "...",
  ...
}
```

This allows assets/jobs to be grouped without implementing an agent framework.

---

# 30. MCP Resources

Expose useful state as resources.

Examples:

```text
higgsfield://models
higgsfield://models/{id}

higgsfield://jobs/{id}

higgsfield://assets/{id}

higgsfield://capabilities
```

Resources SHOULD complement tools rather than duplicate operations.

---

# 31. Structured Content

Tools MUST prefer structured MCP responses.

Example:

```json
{
  "job_id": "job_x",
  "status": "completed",
  "assets": [
    {
      "type": "image",
      "url": "...",
      "width": 2048,
      "height": 2048
    }
  ]
}
```

Human-readable text MAY accompany structured content.

Agents MUST NOT need to parse prose to recover IDs.

---

# 32. Error Model

Canonical errors:

```ts
type ErrorCode =
  | "AUTHENTICATION_FAILED"
  | "ACCESS_DENIED"
  | "INSUFFICIENT_CREDITS"
  | "INVALID_INPUT"
  | "MODEL_NOT_FOUND"
  | "MODEL_UNAVAILABLE"
  | "RATE_LIMITED"
  | "MEDIA_UPLOAD_FAILED"
  | "JOB_NOT_FOUND"
  | "JOB_FAILED"
  | "TIMEOUT"
  | "CANCELLED"
  | "COST_LIMIT_EXCEEDED"
  | "POLICY_REJECTED"
  | "PROVIDER_ERROR"
  | "INTERNAL_ERROR";
```

Response:

```ts
{
  code: ErrorCode

  message: string

  retryable: boolean

  retry_after_ms?: number

  details?: Record<string, unknown>
}
```

---

# 33. Retry Policy

Automatically retry only safe transient failures.

Examples:

```text
429
502
503
504
network reset
```

Use exponential backoff + jitter.

Never automatically retry billable generation unless provider semantics guarantee request idempotency.

---

# 34. Authentication

## stdio

Use environment variables:

```env
HF_API_CREDENTIALS=...
```

Credentials MUST NOT be passed through tool arguments.

## Remote MCP

Support bearer authentication initially.

```text
Authorization: Bearer ...
```

Future:

```text
OAuth/OIDC
```

---

# 35. Multi-Tenant Design

Remote deployments SHOULD support:

```text
tenant
  ↓
credential binding
  ↓
quotas
  ↓
jobs/assets
```

Credentials MUST NOT be stored in job payloads.

Recommended abstraction:

```ts
interface CredentialResolver {
  resolve(context: RequestContext):
    Promise<ProviderCredentials>;
}
```

Implementations:

```text
EnvironmentCredentialResolver
EncryptedDatabaseCredentialResolver
SecretManagerCredentialResolver
```

---

# 36. Cost Controls

Generative media can be expensive.

Support:

```env
HF_MCP_MAX_JOB_COST_USD=
HF_MCP_DAILY_COST_LIMIT_USD=
HF_MCP_REQUIRE_CONFIRM_ABOVE_USD=
```

Where provider pricing is known, expose estimated cost before execution.

---

# 37. Confirmation

Expensive operations MAY return:

```text
confirmation_required
```

Example:

```json
{
  "status": "confirmation_required",
  "estimated_cost_usd": 8.40,
  "confirmation_token": "..."
}
```

The agent can ask the user and resume execution.

This SHOULD be implemented after baseline generation is stable.

---

# 38. Rate Limiting

Remote deployments MUST support limits by:

```text
tenant
API token
tool
provider
```

Example:

```text
generate_image:
  30/min

generate_video:
  5/min
```

Limits MUST be configurable.

---

# 39. Concurrency Control

Generation concurrency SHOULD be controlled independently from HTTP request concurrency.

Example:

```env
HF_MCP_MAX_IMAGE_JOBS=10
HF_MCP_MAX_VIDEO_JOBS=3
```

Queue excess operations.

---

# 40. Persistence

## Local mode

Default:

```text
in-memory
```

Optional:

```text
SQLite
```

## Production remote mode

Recommended:

```text
PostgreSQL
Redis
R2/S3
```

PostgreSQL:

```text
jobs
assets
tenants
usage
audit_events
```

Redis:

```text
locks
rate limits
short-lived job state
queues
```

Object storage:

```text
generated media
uploaded media
```

---

# 41. Job Recovery

Remote deployments MUST survive restart.

On startup:

```text
load incomplete jobs
      ↓
query provider
      ↓
reconcile status
```

Never mark unknown jobs as failed solely because the gateway restarted.

---

# 42. Observability

Every request MUST receive:

```text
request_id
trace_id
```

Generation additionally receives:

```text
job_id
provider_job_id
```

Structured log example:

```json
{
  "event": "generation.completed",
  "request_id": "...",
  "job_id": "...",
  "provider": "higgsfield",
  "model": "...",
  "duration_ms": 18234
}
```

Never log:

```text
API credentials
authorization headers
signed upload credentials
private media bytes
```

---

# 43. Metrics

Expose:

```text
/mcp
/health
/ready
/metrics
```

Metrics:

```text
mcp_tool_calls_total
mcp_tool_errors_total

generation_jobs_total
generation_job_duration_seconds

provider_requests_total
provider_errors_total

media_upload_bytes_total

estimated_cost_usd_total

active_jobs
queued_jobs
```

---

# 44. OpenTelemetry

Production deployment SHOULD support:

```text
OTEL_EXPORTER_OTLP_ENDPOINT
```

Trace:

```text
MCP call
   ↓
capability
   ↓
provider submit
   ↓
poll
   ↓
asset handling
```

---

# 45. Health Checks

`GET /health`

Answers whether process is alive.

`GET /ready`

Checks:

```text
configuration
database
Redis when enabled
provider initialization
object storage when enabled
```

Do NOT perform billable generation as a health check.

---

# 46. Configuration

Configuration priority:

```text
CLI args
   ↓
environment
   ↓
config file
   ↓
defaults
```

Example:

```env
HF_API_CREDENTIALS=

HF_MCP_TRANSPORT=stdio

HF_MCP_HOST=0.0.0.0
HF_MCP_PORT=3000

HF_MCP_LOG_LEVEL=info

HF_MCP_ALLOWED_PATHS=/workspace

HF_MCP_ASSET_MODE=passthrough

HF_MCP_MAX_IMAGE_JOBS=10
HF_MCP_MAX_VIDEO_JOBS=3

HF_MCP_DATABASE_URL=
HF_MCP_REDIS_URL=

HF_MCP_S3_ENDPOINT=
HF_MCP_S3_BUCKET=
```

Validate configuration at startup.

Fail fast on invalid required configuration.

---

# 47. CLI

Binary:

```text
higgsfield-mcp
```

Commands:

```bash
higgsfield-mcp serve

higgsfield-mcp serve --transport stdio

higgsfield-mcp serve \
  --transport http \
  --port 3000

higgsfield-mcp doctor

higgsfield-mcp models

higgsfield-mcp skills list

higgsfield-mcp skills sync

higgsfield-mcp version
```

Default:

```bash
higgsfield-mcp
```

equals:

```bash
higgsfield-mcp serve --transport stdio
```

---

# 48. Doctor Command

`doctor` SHOULD verify:

```text
✓ Node version
✓ credentials available
✓ Higgsfield API reachable
✓ MCP configuration
✓ allowed paths
✓ storage
✓ database
✓ skill compatibility
```

It MUST NOT perform paid generation by default.

---

# 49. npm Distribution

Package SHOULD support:

```bash
npx higgsfield-mcp
```

and:

```bash
npm install -g higgsfield-mcp
```

Package MUST expose:

```json
{
  "bin": {
    "higgsfield-mcp": "./dist/cli.js"
  }
}
```

---

# 50. Docker

Production image:

```text
node:22-slim
```

Use multi-stage build.

Container MUST:

- run non-root;
- use read-only filesystem where practical;
- expose no credentials in image layers;
- support SIGTERM graceful shutdown;
- include healthcheck;
- minimize installed OS packages.

Example:

```bash
docker run \
  -e HF_API_CREDENTIALS=... \
  -p 3000:3000 \
  higgsfield-mcp \
  serve --transport http
```

---

# 51. Graceful Shutdown

On SIGTERM:

```text
stop accepting requests
        ↓
stop new jobs
        ↓
persist job state
        ↓
finish short operations
        ↓
close database/Redis
        ↓
exit
```

Do not cancel remote Higgsfield jobs automatically.

They MAY continue and be reconciled after restart.

---

# 52. Security Requirements

Production release MUST include:

- input validation;
- path traversal prevention;
- SSRF protection;
- secrets redaction;
- request size limits;
- upload size limits;
- authentication;
- rate limiting;
- endpoint allowlists;
- safe error serialization;
- dependency auditing;
- container non-root user;
- no arbitrary command execution.

---

# 53. Provider Endpoint Allowlist

Direct `generate` MUST NOT permit arbitrary URLs.

Only provider endpoint identifiers from registry/configuration may be used.

Never implement:

```text
generate({
  url: arbitrary_url
})
```

---

# 54. Webhook Security

If Higgsfield webhooks are supported:

```text
POST /webhooks/higgsfield
```

Must provide:

- secret validation;
- replay protection where possible;
- timestamp checking where available;
- idempotent processing;
- body size limits.

Never trust job IDs from unsigned callbacks.

---

# 55. Testing Strategy

Four levels.

## Unit

Test:

```text
schema validation
model routing
cost rules
path validation
URL validation
error mapping
skill patching
```

## Contract

Mock Higgsfield API and verify:

```text
request body
auth
polling
error mapping
webhook handling
```

## MCP integration

Start real MCP server and call:

```text
tools/list
tools/call
resources/list
resources/read
```

Validate structured responses.

## E2E

Optional paid CI/manual suite:

```text
generate image
poll job
retrieve asset
image → video
cancel job
```

Paid E2E MUST NOT run on every PR.

---

# 56. Skill Evals

Each skill MUST have scenario-based tests.

Example:

```text
User:
"Create a professional lifestyle product photo
using this uploaded bottle image."
```

Expected behavior:

```text
select product-photoshoot skill

identify lifestyle_scene

upload reference if required

call correct MCP tool

preserve product identity

return generated asset
```

Evaluation SHOULD focus on tool selection and workflow correctness, not exact natural-language output.

---

# 57. Contract Stability

MCP tools are public API.

Do NOT casually change:

```text
tool names
input fields
output fields
error codes
resource URIs
```

Use semantic versioning.

Breaking MCP contract:

```text
major version
```

New optional field:

```text
minor version
```

Bug fix:

```text
patch version
```

---

# 58. Capability Versioning

Expose:

```json
{
  "gateway_version": "1.2.0",
  "mcp_protocol": "2026-07-28",
  "provider": {
    "higgsfield": "..."
  },
  "skills_version": "...",
  "capabilities": []
}
```

This allows skills to verify compatibility.

---

# 59. Feature Flags

Experimental functionality MUST be gated.

Example:

```env
HF_MCP_EXPERIMENTAL_AGENT_API=false
HF_MCP_EXPERIMENTAL_DYNAMIC_MODELS=false
```

Experimental provider functionality MUST NOT become required for core operation.

---

# 60. Higgsfield Agent API

Treat Higgsfield Agent API as experimental.

Potential future adapter:

```text
higgsfield.agent.session.create
higgsfield.agent.session.send
higgsfield.agent.session.messages
higgsfield.agent.session.interrupt
```

It MUST NOT become a dependency of:

```text
generate_image
generate_video
edit_image
jobs.*
```

The gateway must remain usable if Agent API access is unavailable.

---

# 61. Suggested Internal API

Capability layer:

```ts
interface CreativeCapabilities {
  generateImage(
    request: GenerateImageRequest,
    context: RequestContext
  ): Promise<GenerationJob>;

  editImage(
    request: EditImageRequest,
    context: RequestContext
  ): Promise<GenerationJob>;

  generateVideo(
    request: GenerateVideoRequest,
    context: RequestContext
  ): Promise<GenerationJob>;

  animateImage(
    request: AnimateImageRequest,
    context: RequestContext
  ): Promise<GenerationJob>;
}
```

MCP tool:

```text
parse
  ↓
validate
  ↓
capability.generateImage()
  ↓
serialize MCP result
```

---

# 62. Request Context

```ts
interface RequestContext {
  requestId: string;

  tenantId?: string;
  workspaceId?: string;

  transport:
    | "stdio"
    | "http";

  auth?: AuthContext;

  trace?: TraceContext;
}
```

Never pass global mutable request state.

---

# 63. High-Level Workflow Example

User:

```text
Create a cinematic 15-second launch video
using these product photos.
```

Agent:

```text
load relevant Higgsfield skill

        ↓

inspect available capabilities

        ↓

media.upload(product photos)

        ↓

generate_image(...)
create hero frame

        ↓

generate_video(...)
animate hero frame

        ↓

jobs.wait(...)

        ↓

inspect result

        ↓

optional refinement

        ↓

return final assets
```

The gateway performs execution.

The skill supplies workflow intelligence.

The agent supplies reasoning.

---

# 64. Multi-Agent Example

```text
                    Supervisor
                        │
              reads campaign goal
                        │
          ┌─────────────┴─────────────┐
          │                           │
     Image Agent                 Video Agent
          │                           │
product-photoshoot skill       generate skill
          │                           │
          └─────────────┬─────────────┘
                        │
                Higgsfield MCP
                        │
                    Job Store
                        │
                  Higgsfield API
```

Agents communicate through their host.

Generated assets can be shared through:

```text
asset_id
job_id
workspace_id
```

The MCP server does not need to understand agent hierarchy.

---

# 65. MVP Definition

Production MVP MUST include:

```text
✓ stdio MCP

✓ Streamable HTTP MCP

✓ Higgsfield credentials

✓ provider adapter

✓ generate_image

✓ edit_image

✓ generate_video

✓ animate_image

✓ generic generate

✓ media.upload

✓ models.list

✓ models.get

✓ jobs.get

✓ jobs.wait

✓ jobs.cancel

✓ structured errors

✓ path security

✓ SSRF protection

✓ structured logging

✓ Docker

✓ npm package

✓ doctor

✓ unit tests

✓ integration tests

✓ first 3 patched skills
```

MVP MUST NOT require:

```text
PostgreSQL
Redis
R2
multi-tenancy
Agent API
```

---

# 66. Production v1

Add:

```text
PostgreSQL persistence

Redis rate limiting / locks

managed object storage

tenant authentication

usage tracking

cost controls

metrics

OpenTelemetry

skill sync automation

all compatible Higgsfield creative skills

webhook processing

job recovery
```

---

# 67. Future v2

Potential additions:

```text
provider abstraction beyond Higgsfield

workflow checkpoints

approval protocol

asset lineage

generation caching

prompt/version lineage

creative project resources

batch operations

MCP Tasks integration

provider fallback

policy engine

organization quotas
```

Do NOT implement these before core reliability.

---

# 68. Development Phases

## Phase 1 — Foundation

Build:

```text
monorepo
config
logging
Higgsfield client
provider abstraction
MCP stdio
generate
job normalization
```

Exit criterion:

Agent can generate one image reliably.

---

## Phase 2 — Creative Core

Add:

```text
generate_image
edit_image
generate_video
animate_image
media upload
model registry
job tools
```

Exit criterion:

Image → video workflow works entirely through MCP.

---

## Phase 3 — Skills

Integrate:

```text
higgsfield-generate
higgsfield-soul-id
higgsfield-product-photoshoot
```

Build:

```text
skill patcher
skill validator
skill tests
```

Exit criterion:

Compatible agent can complete multi-stage workflows using skills + MCP without Higgsfield CLI.

---

## Phase 4 — Remote Production

Add:

```text
Streamable HTTP
authentication
PostgreSQL
Redis
object storage
rate limiting
job recovery
metrics
```

Exit criterion:

Gateway can safely serve multiple remote agents.

---

## Phase 5 — Full Creative Skill Coverage

Port remaining compatible skills.

Add:

```text
skill sync CI
compatibility matrix
skill eval suite
```

Exit criterion:

Most upstream creative workflows operate without direct CLI dependency.

---

# 69. CI/CD

Pull requests:

```text
lint
typecheck
unit
contract tests
MCP integration
skill validation
security audit
Docker build
```

Main branch:

```text
all PR checks
package build
container build
```

Release:

```text
npm publish
Docker image
GitHub release
SBOM
release notes
```

---

# 70. Compatibility Matrix

Maintain:

```text
docs/compatibility.md
```

Example:

| Feature | MCP | Higgsfield API | Skill |
|---|---|---|---|
| Image generation | Stable | Supported | generate |
| Image edit | Stable | Supported | generate |
| Video | Stable | Supported | generate |
| Soul ID | Stable | Supported | soul-id |
| Product shoot | Stable | Supported | product-photoshoot |
| Agent API | Experimental | Preview | none/core-independent |
| Websites | Out of scope | CLI-specific workflow | websites |

---

# 71. Documentation

Required:

```text
README.md

docs/
├── architecture.md
├── installation.md
├── configuration.md
├── tools.md
├── skills.md
├── deployment.md
├── security.md
├── observability.md
├── compatibility.md
└── contributing.md
```

README quick start MUST allow first successful generation within approximately five minutes after credentials are available.

---

# 72. Example MCP Configuration

Generic local pattern:

```json
{
  "mcpServers": {
    "higgsfield": {
      "command": "npx",
      "args": [
        "-y",
        "higgsfield-mcp"
      ],
      "env": {
        "HF_API_CREDENTIALS": "${HF_API_CREDENTIALS}"
      }
    }
  }
}
```

Host-specific documentation MAY differ.

Do not hardcode credentials into committed configuration.

---

# 73. Definition of Done

The project is production-ready when:

1. An MCP-compatible agent can discover Higgsfield capabilities.

2. It can upload/reference local media safely.

3. It can generate images.

4. It can edit images.

5. It can generate video.

6. It can execute image-to-video workflows.

7. Long jobs do not depend on one long MCP request.

8. Jobs survive production gateway restarts.

9. Provider errors become stable structured MCP errors.

10. Secrets never appear in logs or MCP responses.

11. Remote deployments are authenticated and rate-limited.

12. Higgsfield-compatible skills can invoke MCP instead of the Higgsfield CLI.

13. Skill workflows can chain generated assets.

14. Different agent hosts can use the same MCP server.

15. Multi-agent hosts can share asset/job references through the gateway.

16. Upstream skill updates can be detected and adapted without manually rebuilding the integration.

17. npm and Docker distributions are reproducible.

18. Core operation does not depend on experimental Higgsfield Agent APIs.

---

# 74. Architecture Rule

The most important architectural rule of the project:

```text
┌──────────────────────────────────────────────┐
│                                              │
│ Skills decide WHAT should happen.            │
│                                              │
│ Agents decide WHEN and WHY it should happen. │
│                                              │
│ MCP guarantees HOW it happens.               │
│                                              │
│ Higgsfield performs the generation.          │
│                                              │
└──────────────────────────────────────────────┘
```

Maintaining this separation keeps the project portable across agent ecosystems and resilient to changes in individual models, skills, and agent hosts.

---

# 75. Final Target

The final developer experience should be:

```bash
export HF_API_CREDENTIALS="..."

npx higgsfield-mcp
```

Connect it to an MCP-compatible agent, install compatible Higgsfield skills, and request:

```text
Create a complete product launch campaign using these
three product photos.

I need:

- hero product images
- three social creatives
- one cinematic launch video
- one vertical short video

Keep the product visually consistent across all assets.
```

The agent and skills determine the creative workflow.

The agent may delegate stages to subagents when its host supports them.

Every agent uses the same standardized MCP capabilities.

The gateway handles media, models, jobs, provider execution, security, observability, and production reliability.

**No Higgsfield CLI dependency is required for generation execution.**
