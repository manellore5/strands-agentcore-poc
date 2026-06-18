# Strands TypeScript on Amazon Bedrock AgentCore — POC Delivery

**Status:** ✅ Delivered (live deployment in AWS, Bedrock-native)
**Stack:** TypeScript · Strands Agents SDK · Amazon Bedrock AgentCore Runtime · Amazon Bedrock (Claude) · Docker · ECR

---

## TL;DR

- Implemented a Strands TypeScript agent and deployed it to Amazon Bedrock AgentCore Runtime in `us-east-1`.
- The agent is **live** in AWS and reachable via the AWS SDK. End-to-end tested with multi-tool prompts.
- LLM calls go through **Amazon Bedrock** (Claude Haiku 4.5 via inference profile) — fully AWS-native with **zero API keys** anywhere in the system.
- Why **Strands**: it's the cleanest framework for writing the agent loop (LLM ↔ tools ↔ result) with type-safe tool definitions.
- Why **AgentCore**: it's the production hosting layer — managed runtime, session isolation, IAM, observability — so we don't reinvent that infrastructure.
- Why **Bedrock**: same per-token Claude pricing as direct Anthropic API, but auth flows through AWS IAM — no secrets to manage, audit, or rotate.

---

## What was asked

> *"Please implement Strands TypeScript API in AgentCore, and tell me why we need Strands and why we need AgentCore."*

## What was delivered

| Deliverable | Status | Evidence |
|---|---|---|
| Working Strands agent in TypeScript | ✅ | `index.ts` — agent with two tools (calculator + real-time weather) |
| Deployed to AgentCore Runtime | ✅ | Live runtime ARN, status `READY` |
| End-to-end tested | ✅ | Multi-tool prompts returning real data over the AWS SDK |
| AWS-native authentication (no secrets) | ✅ | IAM role with `bedrock:InvokeModel` permission; no API keys anywhere |
| Why-Strands / why-AgentCore explainer | ✅ | This document, sections below |
| Reusable deployment + reference notes | ✅ | Separate notes doc with full runbook |

**Sample live invocation against the deployed agent:**

```
Prompt:   "What is the weather in Sydney, and what is 17 squared?"
Response: Weather in Sydney: 12.5°C, clear, 16.1 km/h wind.
          17 squared: 289.
Latency:  ~1.2 seconds end-to-end
```

The agent autonomously called the weather tool (which itself fans out to two Open-Meteo API calls) and the calculator tool in a single conversation, then composed the response.

---

## Why we need Strands

Strands Agents is an open-source SDK from AWS for building AI agents. An "agent" is an LLM running in a loop where it can decide to call tools, read their results, and continue until the task is done — meaningfully different from a chatbot.

Without a framework like Strands, we'd have to write the agent loop ourselves: call the LLM, parse tool calls out of its response, execute the tools, feed results back, manage conversation state, handle streaming, retries, and message formatting. Strands gives us all of that in a clean API.

**Concretely, what Strands provides:**

- An `Agent` class that runs the reasoning loop
- A `tool()` helper that turns a TypeScript function into something the LLM can invoke, with Zod-based runtime input validation and full type inference
- Pluggable model providers (Bedrock, Anthropic direct, OpenAI, Google) — swap providers in one line
- Native MCP (Model Context Protocol) support
- Streaming, structured output, multi-agent patterns

**Practical signal of value:** my agent definition is ~30 lines of code. The equivalent hand-rolled would be ~300 lines plus ongoing maintenance burden as LLM provider APIs evolve. Strands abstracts the moving parts.

The TypeScript SDK is still labeled "experimental" (launched December 2025) — fine for POC and internal tooling, but we should pin to a specific version for any production work and watch the changelog.

---

## Why we need AgentCore

Amazon Bedrock AgentCore is AWS's hosting and infrastructure platform for AI agents. Strands is the *framework* we write the agent in; AgentCore is *where* it runs in production.

**What AgentCore provides that we'd otherwise build ourselves:**

| Component | Used in this POC? | Why it matters |
|---|---|---|
| **Runtime** | ✅ Yes | Managed container hosting with session isolation |
| **Memory** | Not yet | Persistent conversation memory across sessions |
| **Identity** | Not yet | Managed API keys and OAuth tokens for tools |
| **Gateway** | Not yet | Turn APIs into agent tools |
| **Code Interpreter** | Not yet | Sandboxed code execution |
| **Browser** | Not yet | Cloud-based web automation |
| **Observability** | ✅ Built-in | CloudWatch logs, metrics, X-Ray traces — automatic |

Running an agent locally is easy. Running one at scale — securely, with session isolation, persistent memory, observability, and auth — is hard. AgentCore handles that infrastructure so we don't reinvent it.

**The clean part:** the contract between Strands and AgentCore is dead simple. AgentCore Runtime is a container host that expects two HTTP endpoints — `GET /ping` and `POST /invocations`. As long as our container speaks that contract, AgentCore handles deployment, scaling, IAM, and observability.

---

## Why we use Bedrock for the LLM

Amazon Bedrock is AWS's managed LLM service. It hosts Claude (Anthropic), Llama (Meta), Mistral, Nova, and others behind one unified API.

**Three reasons Bedrock is the right call for our project:**

1. **No secrets in production.** Bedrock authenticates via AWS IAM. Our AgentCore runtime assumes an IAM role that includes `bedrock:InvokeModel` permission, and every Claude call is signed using temporary AWS credentials — no API key in the container, no env var in the deployment config, no rotation policy to maintain.

2. **Data stays in AWS.** Prompts and responses never leave the AWS network boundary. For any future use case involving customer or sensitive data, this is a hard requirement.

3. **Provider flexibility.** Bedrock fronts multiple LLM providers. Switching from Claude Haiku to Claude Sonnet, or evaluating Llama vs Nova, is a one-line model ID change in our code. No new authentication, no new SDK, no new billing relationship.

**Per-token cost is identical** to calling Anthropic directly ($1/$5 per million tokens for Haiku 4.5). AWS doesn't mark up the model. The choice between Bedrock and direct provider APIs is operational, not financial.

---

## How the pieces fit together

```
Caller (AWS SDK)
      │
      ▼
AgentCore Runtime  ←── managed by AWS (deployment, scaling, IAM, logging)
      │
      ▼
Our container  ←── Express server, our code
      │
      ▼
Strands Agent  ←── orchestrates LLM + tools
      │     │
      │     └──► Tools (calculator, weather)
      ▼
Bedrock (Claude Haiku 4.5)  ←── invoked via IAM role; no API keys
```

---

## What's deployed right now

| Resource | Identifier (redacted) |
|---|---|
| AWS Account | `[REDACTED]` |
| Region | `us-east-1` |
| ECR Repository | `[ACCOUNT].dkr.ecr.us-east-1.amazonaws.com/my-agent-service:latest` |
| IAM Role | `arn:aws:iam::[ACCOUNT]:role/BedrockAgentCoreRuntimeRole` |
| AgentCore Runtime | `arn:aws:bedrock-agentcore:us-east-1:[ACCOUNT]:runtime/my_agent_service-[ID]` |
| LLM provider | Amazon Bedrock — Claude Haiku 4.5 via cross-region inference profile |
| Status | `READY` |

The agent's two tools:

1. **`calculator`** — basic arithmetic, demonstrating typed inputs (Zod) and pure-function tools
2. **`get_current_weather`** — calls Open-Meteo's free public API to fetch real-time weather for any city, demonstrating tools that make external HTTP calls

---

## What I learned (worth flagging)

A few takeaways from this POC that are useful context for follow-up work:

- **The Strands TypeScript SDK is in preview.** Core features (Agent, tool, BedrockModel, MCP) are solid. Multi-agent patterns (Graph, Swarm) and the BidiAgent (voice) are Python-only today. If we need those features, we'd write them by hand in TS or use the Python SDK.
- **AgentCore Runtime contracts are language-agnostic.** Our Express + TypeScript container is one valid implementation; we could use Python/FastAPI, Go, Rust — anything that speaks `/ping` + `/invocations`. Useful flexibility if other teams contribute later.
- **Claude 4.x models on Bedrock require inference profile IDs** (the `us.anthropic.claude-...` form), not raw on-demand model IDs. Easy to miss; worth flagging in any future docs.
- **AWS new-account Bedrock quota provisioning can take 1-2 weeks via Support.** Worth filing the case early if a future project needs Bedrock on a fresh account.

---

## Suggested next steps

In rough priority order:

1. **Add real domain tools** — the calculator/weather pair was a deliberately generic demo. Real value comes from tools that interact with our actual systems (e.g., querying internal APIs, reading from S3, etc.).
2. **Wire in AgentCore Memory** — for any agent that needs to remember context across sessions. Currently each invocation is stateless.
3. **Set up CloudWatch alarms + dashboards** — agent observability is built in but unused; we should track invocation counts, error rates, p95 latency.
4. **Multi-stage Docker build** to shrink the image from ~400MB to ~80MB. Faster deploys, important if we iterate often.
5. **Evaluate AgentCore Identity** — for any tools that need to authenticate to external services (e.g., calling internal APIs with OAuth).
6. **Pin Strands SDK version** in `package.json` to avoid surprise breaking changes from the experimental SDK.

---

## A note on the development path

This POC went through a two-stage development sequence. During initial development, our brand-new AWS account had Bedrock token quotas provisioned at 0 (a known issue for new accounts — required an AWS Support case to resolve). Rather than block the project, I built the agent against Anthropic's direct API as a fallback, then swapped to Bedrock once quotas were granted. This required only a two-line code change thanks to Strands' provider abstraction — exact same agent, exact same tools, exact same deployment, just a different LLM auth path. **The current production deployment uses Bedrock.** The Anthropic-direct path is documented in our notes doc as an alternative for any future scenario where Bedrock isn't available (e.g., another new account).

---

## Reference materials

- Full deployment runbook and concept glossary: *(see attached notes doc)*
- Source code: *(see repo: `my-agent-service`)*
- Strands TypeScript docs: https://strandsagents.com/docs/user-guide/quickstart/typescript/
- AgentCore Runtime deployment guide: https://strandsagents.com/docs/user-guide/deploy/deploy_to_bedrock_agentcore/typescript/

---

*Happy to walk through any of this live or demo the running agent — both take ~5 minutes.*
