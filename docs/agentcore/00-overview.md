# AgentCore Services — Overview & Learning Map

> Companion to `strands-agentcore-Detailedsteps.md` (which covers **Runtime**, already implemented).
> This folder learns the *remaining* AgentCore services one at a time: concept first, then a hands-on TypeScript POC that plugs into our existing Strands agent.

---

## The mental model

Amazon Bedrock AgentCore is a set of **independent, composable services**. You do not have to adopt all of them. Each solves one hard part of running an agent in production, and each can be added to an agent that already runs on Runtime (which is what we built).

```
                         ┌─────────────────────────────────────────┐
                         │              YOUR AGENT                   │
                         │   (Strands SDK + Bedrock model)           │
                         └─────────────────────────────────────────┘
                                          │
        ┌──────────────┬─────────────────┼──────────────┬───────────────┐
        ▼              ▼                 ▼              ▼               ▼
  ┌──────────┐  ┌──────────┐     ┌────────────┐  ┌──────────┐   ┌────────────┐
  │ RUNTIME  │  │  MEMORY  │     │  GATEWAY   │  │ IDENTITY │   │   TOOLS    │
  │ host the │  │ remember │     │ APIs →     │  │ secure   │   │ code-interp│
  │ container│  │ across   │     │ agent tools│  │ access / │   │ + browser  │
  │ (DONE)   │  │ sessions │     │ (MCP)      │  │ OAuth    │   │ (sandboxed)│
  └──────────┘  └──────────┘     └────────────┘  └──────────┘   └────────────┘
                                          │
                                          ▼
                                  ┌────────────────┐
                                  │ OBSERVABILITY  │  (cuts across all of them:
                                  │ logs/metrics/  │   CloudWatch traces, spans)
                                  │ traces         │
                                  └────────────────┘
```

## The 7 services at a glance

| Service | One-line job | Problem it removes | Our doc |
|---|---|---|---|
| **Runtime** | Host the agent container, isolate sessions, scale | Building secure, session-isolated hosting yourself | `../../strands-agentcore-Detailedsteps.md` ✅ |
| **Memory** | Remember context within & across sessions | Building a conversation store + fact-extraction pipeline | [`01-memory.md`](01-memory.md) · [ELI5](01-memory-ELI5.md) |
| **Gateway** | Turn existing APIs / Lambdas into agent tools (MCP) | Hand-writing + hosting a tool wrapper for every API | `02-gateway.md` |
| **Identity** | Let the agent securely call AWS + 3rd-party services | Managing OAuth tokens / API keys / credential vaulting | `03-identity.md` |
| **Observability** | Logs, metrics, traces via CloudWatch | Instrumenting agent runs by hand | `04-observability.md` |
| **Code Interpreter** | Run model-generated code in a sandbox | Standing up + securing a code execution sandbox | `05-code-interpreter.md` |
| **Browser Tool** | Cloud-based web automation for the agent | Running + scaling headless browsers safely | `06-browser-tool.md` |

## How each service relates to what we already built

Our Runtime agent (`index.ts`) is an Express server that:
- exposes `GET /ping` + `POST /invocations` (the Runtime contract),
- builds one `strands.Agent` with a Bedrock model and two tools (`calculator`, `get_current_weather`),
- runs the agent per request and returns the result.

Each new service hangs off that same agent:

- **Memory** → before running the agent, load relevant past context; after, save the new turns. Scoped by `actorId` (who) + `sessionId` (which conversation).
- **Gateway** → instead of (or in addition to) hand-written `strands.tool(...)` definitions, the agent discovers tools from a Gateway endpoint (MCP). New APIs become tools without redeploying the agent.
- **Identity** → when a tool needs to call, say, Google or an internal API on behalf of the user, Identity vaults and injects the credential instead of us managing secrets.
- **Observability** → wraps the whole `/invocations` handler so every model call, tool call, and memory read shows up as a trace in CloudWatch.
- **Code Interpreter / Browser** → two more tools the agent can call, except the heavy/dangerous execution happens in an AWS-managed sandbox, not in our container.

## Learning method (per service)

For each service there are **two docs**:
- `0X-<service>.md` — the main doc (concept + API + hands-on POC).
- `0X-<service>-ELI5.md` — an intuition-first, jargon-free explainer to read *first*.

The main `0X-*.md` doc follows the same shape so they're easy to compare:

1. **What it is** — plain-English definition.
2. **When to use it / when not to** — so we don't cargo-cult.
3. **Key concepts & vocabulary** — the terms AWS uses.
4. **How it fits our agent** — the specific change to `index.ts` / the project.
5. **Hands-on POC** — runnable TypeScript, grounded in the current SDK.
6. **Gotchas, limits, pricing** — what bites you in practice.

## Order we're tackling them

1. **Memory** ← start here (most natural follow-on from Runtime)
2. **Gateway**
3. **Identity**
4. **Observability + Code Interpreter + Browser**

## Key environment facts (carried over from the Runtime work)

- Language: **TypeScript** (Strands TS SDK is experimental but working in our repo).
- Auth story: **pure AWS IAM** — no API keys. Memory/Gateway/etc. calls are signed with the same role.
- Region in `index.ts`: model is pinned to `us-east-1`; AgentCore Memory examples often use `us-west-2`. **Pick one region and keep all AgentCore resources there** to avoid cross-region confusion.
- The relevant AWS SDK v3 client for these services is **`@aws-sdk/client-bedrock-agentcore`** (data plane) and **`@aws-sdk/client-bedrock-agentcore-control`** (control plane: create/list/delete resources).
