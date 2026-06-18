# Strands + AgentCore Deployment — Complete Notes (Bedrock Edition)

> Personal reference notes from implementing a Strands TypeScript agent on Amazon Bedrock AgentCore Runtime, using Amazon Bedrock as the LLM provider. Covers concepts, definitions, the full deployment process, iteration workflow, and an alternative provider approach in the appendix.

---

## Table of contents

1. [What we built and why](#1-what-we-built-and-why)
2. [Core concepts (glossary)](#2-core-concepts-glossary)
3. [Project files explained](#3-project-files-explained)
4. [The deployment process (end-to-end)](#4-the-deployment-process-end-to-end)
5. [Iteration workflow — updating a deployed agent](#5-iteration-workflow--updating-a-deployed-agent)
6. [Adding more tools to the agent](#6-adding-more-tools-to-the-agent)
7. [Cleanup and cost notes](#7-cleanup-and-cost-notes)
8. [Lessons learned (the hard way)](#8-lessons-learned-the-hard-way)
9. [Quick reference cheatsheet](#9-quick-reference-cheatsheet)
10. [Quick wins for future iterations](#10-quick-wins-for-future-iterations)
11. [Appendix A — Alternative provider: Anthropic API direct](#11-appendix-a--alternative-provider-anthropic-api-direct)

---

## 1. What we built and why

### The one-sentence summary

We wrote a small HTTP server that wraps a Strands AI agent and exposes the two endpoints AgentCore Runtime requires, then deployed that server as a container on AWS using Amazon Bedrock as the LLM provider. The agent has multiple tools and autonomously routes between them based on user prompts. No API keys anywhere — pure AWS IAM authentication.

### What is Strands?

Strands Agents is an open-source SDK from AWS for building AI agents. An "AI agent" is an LLM running in a loop where it can decide to call tools (functions) and use their results to take further actions, until the task is done.

Without Strands, you'd have to write the agent loop yourself: prompt the LLM, parse tool calls from its response, run the tools, feed results back, repeat. Strands gives you this in ~10 lines of code, plus type-safe tool definitions via Zod schemas, streaming, multiple model providers, etc.

The Python SDK launched May 2025. The TypeScript SDK launched December 2025 and is still labeled "experimental" — fine for development but expect occasional breaking changes.

### What is AgentCore?

Amazon Bedrock AgentCore is AWS's hosting and infrastructure platform for AI agents. Strands is the framework you write your agent in; AgentCore is where you run it in production. AgentCore provides:

- **Runtime** — secure, session-isolated container hosting (what we used)
- **Memory** — persistent conversation memory across sessions
- **Identity** — managed API keys and OAuth tokens
- **Gateway** — turn APIs into agent tools
- **Code Interpreter** — sandboxed code execution
- **Browser** — cloud-based web automation
- **Observability** — logs, metrics, traces via CloudWatch

Running an agent on your laptop is easy. Running one for thousands of users — securely, with session isolation, persistent memory, auth, and observability — is hard. AgentCore handles that infrastructure so you don't reinvent it.

### What is Bedrock?

Amazon Bedrock is AWS's managed LLM service. It lets you call models (Claude, Nova, Llama, Mistral, etc.) using AWS APIs and IAM authentication — no separate API keys needed. The per-token price is identical to calling Anthropic's API directly; AWS doesn't mark up the model.

Bedrock + AgentCore + IAM is the **cleanest possible auth story**: your code has zero secrets to manage. AgentCore assumes an IAM role at runtime, and that role's permissions include `bedrock:InvokeModel`. Every LLM call is automatically signed using temporary AWS credentials — no API keys, no rotation, no env vars.

### Why use Strands + AgentCore + Bedrock together?

Strands is the framework you write your agent in. AgentCore is the AWS platform you deploy that agent to. Bedrock provides the LLM. The three integrate seamlessly because they're all AWS products designed to work together.

The contract between Strands and AgentCore is dead simple: AgentCore Runtime is a container host that expects two HTTP endpoints, `GET /ping` and `POST /invocations`. As long as your container speaks that contract, AgentCore takes care of everything else.

---

## 2. Core concepts (glossary)

### Agent

An LLM that can take actions, not just chat. Given a goal, it decides which tools to call, calls them, reads the results, and continues until the goal is achieved. Compare to a regular chatbot, which does one round trip per user message.

### Tool

A function the LLM is allowed to call. Each tool has:
- A name and description (the description is what the LLM reads to decide whether to use the tool)
- An input schema (defined with Zod in our case) that validates the LLM's call before running it
- A callback function that actually does the work — can be sync or async, can call external APIs

### Multi-tool routing

When an agent has more than one tool, the LLM **autonomously chooses** which tool to call based on the user's prompt and each tool's description. Your code does nothing special — the LLM reads tool descriptions like documentation and picks the right one. If multiple tools are needed in a single conversation, the LLM calls them in sequence and weaves results together.

The quality of your tool descriptions directly affects routing accuracy. Write them like docstrings — clear, action-oriented, with trigger words the user might use.

### Model provider

The LLM "brain" the agent uses. Strands supports many: Bedrock (Claude via AWS), Anthropic (Claude direct), OpenAI, Google, etc. Swapping providers is a one-line change. You provide the credentials each provider needs.

### Inference profile (Bedrock-specific concept)

A wrapper that lets Bedrock route a model call across multiple AWS regions for better availability. Identified by a `us.` prefix (or `eu.`, `ap.`, etc.) on the model ID. **All Claude 4.x models on Bedrock require inference profiles** — you cannot call them with the raw model ID; you must use the `us.anthropic.claude-...` form.

### Container image

A frozen snapshot of "an empty Linux machine + everything needed to run your app." Created with `docker build` using a `Dockerfile`. AWS runs your code by unfreezing this image.

### Container

A running instance of a container image. AgentCore creates and destroys these on demand. Each user session typically gets its own container instance for isolation.

### Dockerfile

A recipe that tells `docker build` how to construct your image. Each line is a step: start from a base OS, copy files in, install dependencies, set the start command.

### ECR (Elastic Container Registry)

AWS's private storage for Docker container images. You push your image here after building it locally; AgentCore pulls from here when starting your container. ECR repos live inside your AWS account.

ECR URLs look like:
```
<account-id>.dkr.ecr.<region>.amazonaws.com/<repo-name>:<tag>
```

### IAM (Identity and Access Management)

AWS's permission system. Controls who (or what AWS service) can do what on which resources. Default is deny — every action must be explicitly allowed.

### IAM user

A human identity in IAM. Has a username, password, and access keys. Used for humans logging into AWS.

### IAM role

A non-human identity. Has no password. Instead, **something assumes the role temporarily** to gain its permissions. Used for AWS services (like AgentCore) acting on your behalf.

A role is like a uniform with badges. The uniform itself is the role. The badges are the permissions. Whoever puts on the uniform can do what the badges allow — nothing more, nothing less.

### Trust policy

A JSON document attached to a role that answers: **"Who is allowed to assume this role?"**

For our AgentCore role, the trust policy says "only the AgentCore service in my account can assume this role." Without it, no one can wear the uniform.

### Permissions policy

A JSON document attached to a role that answers: **"What can the wearer do once they've assumed this role?"**

For our role, the permissions policy lists: pull from ECR, write to CloudWatch logs, **invoke Bedrock models**, etc. The Bedrock permission is critical — it's what lets the deployed agent call Claude without an API key.

### ARN (Amazon Resource Name)

A globally unique address for any AWS resource. Format:

```
arn:aws:<service>:<region>:<account-id>:<resource-type>/<resource-name>
```

Example: `arn:aws:iam::<YOUR_ACCOUNT_ID>:role/BedrockAgentCoreRuntimeRole`

ARNs identify everything in AWS. Anywhere two AWS resources reference each other, an ARN is how.

### STS (Security Token Service)

The AWS service that hands out temporary credentials when roles are assumed. When AgentCore assumes our role, STS verifies the trust policy and issues a short-lived credential AgentCore can use.

### Bedrock token quota

A limit on how many tokens (input + output text chunks) you can send to Bedrock per minute or per day. New accounts often have these set to 0, requiring an AWS Support case to provision. Once provisioned, you don't think about quotas for normal dev usage.

### Strands "the contract"

The fixed interface between any Strands agent and AgentCore Runtime:
- `GET /ping` — health check, must return 200 with `{ "status": "Healthy" }`
- `POST /invocations` — accepts a user prompt as raw bytes, returns the agent's answer

Your container can be in any language. As long as it speaks this contract, AgentCore can host it.

### Express

A small Node.js library for building HTTP servers. Used to expose the `/ping` and `/invocations` endpoints. Three jobs: listen on a port, route requests to handlers, help you read/send HTTP messages.

### Zod

A TypeScript schema validation library. Used to describe tool inputs in a way that gives both compile-time type safety and runtime validation. If the LLM tries to call a tool with bad arguments, Zod rejects them before the tool runs.

---

## 3. Project files explained

The project has 10 files, grouped by purpose:

### A. The actual program

| File | Purpose |
|---|---|
| `index.ts` | The Strands agent + Express server. The only file with business logic. |

### B. Build & dependency config

| File | Purpose |
|---|---|
| `package.json` | Project manifest. Declares dependencies and scripts (`build`, `start`, `invoke`). |
| `tsconfig.json` | TypeScript compiler config. Tells `tsc` how to convert `.ts` → `.js`. |

### C. Container packaging

| File | Purpose |
|---|---|
| `Dockerfile` | Recipe for building the container image. Critical detail: `--platform=linux/arm64` because AgentCore runs on ARM. |
| `.dockerignore` | Files Docker should NOT copy into the image (`node_modules`, `dist`, `.git`). Keeps image size small. |

### D. Deployment & testing

| File | Purpose |
|---|---|
| `create-iam-role.sh` | Bash script that creates the IAM role in one command. (We did this manually on Windows instead.) |
| `invoke.ts` | Test client for the deployed agent. Uses AWS SDK to call the AgentCore Runtime endpoint. |

### Plus

| File | Purpose |
|---|---|
| `README.md` | Human-readable explanation and runbook. |

### `index.ts` structure (Bedrock version)

```
imports
  → Zod, Strands (including BedrockModel), Express

1. Define tools — one per capability
   strands.tool({ name, description, inputSchema (Zod), callback })

2. Build the agent (no secrets, no env vars needed)
   new strands.Agent({
     model: new BedrockModel({
       region: 'us-east-1',
       modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
     }),
     tools: [...],
     systemPrompt: '...',
   })

3. Express server with the AgentCore contract
   app.get('/ping', ...)
   app.post('/invocations', express.raw, async (req, res) => {
     const prompt = TextDecoder().decode(req.body)
     const response = await agent.invoke(prompt)
     res.json({ response })
   })

4. app.listen(8080)
```

---

## 4. The deployment process (end-to-end)

### Big picture

```
Code → Docker image → ECR → AgentCore Runtime → Live agent
```

### Prerequisites

- Node.js 20+
- Docker Desktop installed and running
- AWS CLI installed and configured (`aws configure`)
- AWS account with:
  - Bedrock model access enabled
  - Bedrock token quotas provisioned for the Claude model(s) you'll use (may require AWS Support case for new accounts)
  - Permissions to create IAM roles, ECR repos, and AgentCore runtimes

### Step 1 — Verify AWS CLI

```cmd
aws --version
aws sts get-caller-identity
aws configure get region
```

Expected: CLI version printed, JSON with `Account` field, region is `us-east-1`.

### Step 2 — Verify Bedrock model access

This is the step that gets skipped most often, leading to confusion later. Confirm two things:

**(a) The model exists in your account:**

```cmd
aws bedrock list-foundation-models --region us-east-1 --by-provider Anthropic --query "modelSummaries[?contains(modelLifecycle.status, 'ACTIVE')].{ID:modelId,Name:modelName}" --output table
```

You should see Claude models listed.

**(b) Quotas are provisioned (not zero):**

```cmd
aws service-quotas list-service-quotas --service-code bedrock --region us-east-1 --query "Quotas[?contains(QuotaName, 'Haiku 4.5') && contains(QuotaName, 'per minute')].{Name:QuotaName,Applied:Value}" --output table
```

If applied values are non-zero, you're good. If they're 0, open an AWS Support case (see "Lessons learned" section).

**(c) Test a real Bedrock call:**

```cmd
aws bedrock-runtime invoke-model --model-id us.anthropic.claude-haiku-4-5-20251001-v1:0 --body "{\"anthropic_version\":\"bedrock-2023-05-31\",\"max_tokens\":50,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" --content-type application/json --cli-binary-format raw-in-base64-out --region us-east-1 response.json

type response.json
```

If you see a real Claude response, Bedrock is working. **Note the `us.` prefix** — Claude 4.x models require inference profile IDs.

### Step 3 — Create the IAM role

Create `trust-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AssumeRolePolicy",
      "Effect": "Allow",
      "Principal": { "Service": "bedrock-agentcore.amazonaws.com" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": { "aws:SourceAccount": "<YOUR_ACCOUNT_ID>" },
        "ArnLike": { "aws:SourceArn": "arn:aws:bedrock-agentcore:us-east-1:<YOUR_ACCOUNT_ID>:*" }
      }
    }
  ]
}
```

Create `permissions-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ECRImageAccess", "Effect": "Allow", "Action": ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], "Resource": "arn:aws:ecr:us-east-1:<YOUR_ACCOUNT_ID>:repository/*" },
    { "Sid": "ECRTokenAccess", "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
    { "Effect": "Allow", "Action": ["logs:DescribeLogStreams", "logs:CreateLogGroup"], "Resource": "arn:aws:logs:us-east-1:<YOUR_ACCOUNT_ID>:log-group:/aws/bedrock-agentcore/runtimes/*" },
    { "Effect": "Allow", "Action": "logs:DescribeLogGroups", "Resource": "arn:aws:logs:us-east-1:<YOUR_ACCOUNT_ID>:log-group:*" },
    { "Effect": "Allow", "Action": ["logs:CreateLogStream", "logs:PutLogEvents"], "Resource": "arn:aws:logs:us-east-1:<YOUR_ACCOUNT_ID>:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*" },
    { "Effect": "Allow", "Action": ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"], "Resource": "*" },
    { "Effect": "Allow", "Action": "cloudwatch:PutMetricData", "Resource": "*", "Condition": { "StringEquals": { "cloudwatch:namespace": "bedrock-agentcore" } } },
    { "Sid": "BedrockModelAccess", "Effect": "Allow", "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], "Resource": ["arn:aws:bedrock:*::foundation-model/*", "arn:aws:bedrock:us-east-1:<YOUR_ACCOUNT_ID>:*"] }
  ]
}
```

The `BedrockModelAccess` statement is the critical one — it's what lets the deployed agent call Claude without any API key.

Run:

```cmd
aws iam create-role --role-name BedrockAgentCoreRuntimeRole --assume-role-policy-document file://trust-policy.json --description "Service role for AWS Bedrock AgentCore Runtime"

aws iam put-role-policy --role-name BedrockAgentCoreRuntimeRole --policy-name AgentCoreRuntimeExecutionPolicy --policy-document file://permissions-policy.json
```

**Save the role's ARN** from the first command's output.

### Step 4 — Create the ECR repository

```cmd
aws ecr create-repository --repository-name my-agent-service --region us-east-1
```

Note the `repositoryUri` from the output:
```
<YOUR_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/my-agent-service
```

### Step 5 — Build & push the Docker image

```cmd
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <YOUR_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com

docker build --platform linux/arm64 -t my-agent-service .

docker tag my-agent-service:latest <YOUR_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/my-agent-service:latest

docker push <YOUR_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/my-agent-service:latest
```

**Critical:** `--platform linux/arm64` is required. AgentCore runs on ARM (Graviton). Wrong architecture = container fails with "exec format error."

### Step 6 — Create the AgentCore Runtime

```cmd
aws bedrock-agentcore-control create-agent-runtime --agent-runtime-name my_agent_service --agent-runtime-artifact "containerConfiguration={containerUri=<YOUR_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/my-agent-service:latest}" --role-arn arn:aws:iam::<YOUR_ACCOUNT_ID>:role/BedrockAgentCoreRuntimeRole --network-configuration "networkMode=PUBLIC" --protocol-configuration "serverProtocol=HTTP" --region us-east-1
```

**Notice what is NOT here:** no `--environment-variables`. Bedrock uses IAM auth automatically — there are no secrets to pass.

**Note:** runtime name must use underscores, NOT hyphens.

### Step 7 — Wait for status READY

```cmd
aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id <runtime-id> --region us-east-1 --query "status" --output text
```

Re-run every ~30 seconds until it prints `READY` (~1-2 minutes).

### Step 8 — Test with `invoke.ts`

**Don't use raw AWS CLI for invocations** — it has fiddly base64 quirks. Use the SDK via `invoke.ts`.

1. Open `invoke.ts`
2. Set `YOUR_ACCOUNT_ID`, `YOUR_RUNTIME_ID`, and `PROMPT`
3. Make sure session ID uses `crypto.randomUUID()` (must be ≥33 chars)
4. Run:

```cmd
npm run invoke
```

Expected: JSON response from your deployed agent with `metadata.metrics.latencyMs` (a Bedrock-specific field that confirms the call went through AWS).

---

## 5. Iteration workflow — updating a deployed agent

After your first deployment, every change to the code follows this loop. **Much faster than the initial deploy** because most infrastructure already exists.

### The 6-step iteration cycle

```
Edit code → Rebuild → Push image → Update runtime → Wait READY → Test
```

### Detailed commands

```cmd
:: 1. Rebuild
npm run build

:: 2. Re-auth Docker to ECR (expires every 12 hours)
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <YOUR_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com

:: 3. Rebuild Docker image (faster — most layers cache)
docker build --platform linux/arm64 -t my-agent-service .

:: 4. Tag and push (faster — Docker says "Layer already exists" for unchanged layers)
docker tag my-agent-service:latest <YOUR_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/my-agent-service:latest
docker push <YOUR_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/my-agent-service:latest

:: 5. Tell AgentCore to pick up the new image (no --environment-variables for Bedrock!)
aws bedrock-agentcore-control update-agent-runtime --agent-runtime-id <runtime-id> --agent-runtime-artifact "{\"containerConfiguration\": {\"containerUri\": \"<YOUR_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/my-agent-service:latest\"}}" --role-arn arn:aws:iam::<YOUR_ACCOUNT_ID>:role/BedrockAgentCoreRuntimeRole --network-configuration "{\"networkMode\": \"PUBLIC\"}" --protocol-configuration serverProtocol=HTTP --region us-east-1

:: 6. Wait for READY (UPDATING → READY, takes 1-2 min)
aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id <runtime-id> --region us-east-1 --query "status" --output text

:: 7. Test
npm run invoke
```

### Viewing logs

When the deployed agent misbehaves, CloudWatch logs are your friend:

```cmd
aws logs tail /aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT --region us-east-1 --since 10m --follow
```

---

## 6. Adding more tools to the agent

The whole point of agents is that they have tools. Here's the pattern.

### The tool definition pattern

```typescript
const myTool = strands.tool({
  name: 'tool_name',
  description:
    'Clear, action-oriented description. The LLM reads this to decide when to call the tool. Include trigger words the user might use.',
  inputSchema: z.object({
    paramName: z.string().describe('Hint for the LLM about what to pass'),
  }),
  callback: async (input) => {
    // Do work here. Can be sync or async. Can call external APIs.
    // Throw an Error if something goes wrong — Strands feeds the error
    // back to the LLM, which typically apologizes and explains.
    return { /* structured data */ };
  },
});
```

### Wire the tool into the agent

```typescript
const agent = new strands.Agent({
  model: new BedrockModel({
    region: 'us-east-1',
    modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  }),
  tools: [calculatorTool, weatherTool, /* new tool here */],
  systemPrompt: 'You are a helpful assistant. Use [tool] when the user asks about [thing].',
});
```

### Tips for good tools

1. **The description is what the LLM reads.** Write it like documentation — clear, with trigger words. "Fetches the current weather for any city" beats "Weather function."
2. **Use Zod's `.describe()` on parameters.** It gives the LLM hints about how to format inputs.
3. **Return structured data, not strings.** Return `{ temperature: 12.8, ... }` — the LLM will format prose around it.
4. **Throw Errors on failures.** Don't return error strings. Strands routes thrown errors back to the LLM as feedback.
5. **Update the system prompt.** Anchor the LLM to "use the tool, don't guess" — otherwise it may hallucinate answers.
6. **Tools can call external APIs.** Use `fetch` or any HTTP library. Just remember the call has to finish before the response goes back.

### Multi-tool routing in action

Once an agent has multiple tools, you don't write any routing code — the LLM picks based on tool descriptions. A single prompt can trigger multiple tools in sequence. Example:

> *"What is the weather in Paris, and what is 25 percent of 80?"*

Triggers:
1. `get_current_weather` with `city: "Paris"`
2. `calculator` with `operation: "multiply", a: 80, b: 0.25`
3. LLM weaves both results into one prose response

This is *autonomous tool selection* — the core thing that makes an agent more than a chatbot.

---

## 7. Cleanup and cost notes

### Cost estimate (us-east-1, light development use)

| Resource | Approximate cost |
|---|---|
| ECR storage (~400MB image) | ~$0.04/month |
| AgentCore Runtime (when idle) | ~$0 (charged per invocation) |
| AgentCore Runtime (per invocation) | Small fraction of a cent per call |
| CloudWatch logs | Free tier covers light dev usage |
| Bedrock tokens (Claude Haiku 4.5) | $1/$5 per 1M input/output tokens |

Expect ~$1-5/month total for moderate dev/test usage.

### Bedrock pricing reference (per million tokens, us-east-1)

| Model | Input | Output | Best for |
|---|---|---|---|
| Claude Haiku 4.5 | $1 | $5 | Fast, cheap — what we used |
| Claude Sonnet 4.6 | $3 | $15 | Balanced |
| Claude Opus | $5 | $25 | Most capable |

Note: cross-region inference profiles (the `us.` prefix variants we use) add a 10% surcharge to these rates.

### Tear-down commands when done experimenting

```cmd
aws bedrock-agentcore-control delete-agent-runtime --agent-runtime-id <runtime-id> --region us-east-1

aws ecr delete-repository --repository-name my-agent-service --region us-east-1 --force

aws iam delete-role-policy --role-name BedrockAgentCoreRuntimeRole --policy-name AgentCoreRuntimeExecutionPolicy

aws iam delete-role --role-name BedrockAgentCoreRuntimeRole
```

Run them in this order. (Roles must have policies removed before they can be deleted.)

---

## 8. Lessons learned (the hard way)

Each item below cost real debugging time. Internalize them:

| Lesson | Why it matters |
|---|---|
| **PowerShell's `curl` is fake** (it's `Invoke-WebRequest`). Use `curl.exe` or Command Prompt. | Saves hours on Windows. |
| **Compiled TypeScript ≠ source TypeScript.** Always `npm run build` after editing. | The #1 silent bug. |
| **A running Node process holds its loaded code in memory.** Rebuilding `dist/index.js` doesn't update a running server. Always restart the server (`Ctrl+C`, `npm start`) after changes. Or use `taskkill /F /IM node.exe` to nuke stale processes. | Cost us ~30 min when a tool wouldn't register. |
| **Claude 4.x models on Bedrock require inference profile IDs** (`us.` prefix), not the raw on-demand model ID. The error "on-demand throughput isn't supported" is the giveaway. | Caught us on first Bedrock test after quotas were provisioned. |
| **The AgentCore contract is just `/ping` + `/invocations`.** Language-agnostic, framework-agnostic. | Mental model unlocks everything. |
| **New AWS accounts often have Bedrock token quotas at 0.** Requires AWS Support to fix — quotas pages show "Not adjustable." Took 13 days for our case to be resolved. File the case early; build with a fallback in parallel. | Plan ahead — don't promise demos on day 1. |
| **Servers run in foreground. Keep the terminal open.** Two-terminal dev workflow is normal. | Closing a window kills the server. |
| **`--platform linux/arm64` on `docker build` is mandatory for AgentCore.** | Wrong arch = cryptic "exec format error." |
| **Notepad sneakily appends `.txt` to filenames** unless you wrap the name in quotes when saving, or use "All Files" in the save dialog. Use VS Code instead for fewer surprises. | Cost us 10 min on policy files. |
| **IAM = uniform analogy.** Role is the uniform. Trust policy is the bouncer. Permissions policy is the badges. | Helps every AWS service make sense. |
| **Bedrock + IAM = no secrets to manage.** Compare to third-party APIs where you handle credentials yourself. | Use AWS-native services when possible. |
| **Don't test AgentCore Runtime invocations via raw AWS CLI** — its `--payload` base64 handling is fiddly and platform-dependent. Always use the AWS SDK (`invoke.ts`) which handles encoding correctly. | Wasted ~15 min. |
| **AgentCore Runtime `runtimeSessionId` must be ≥33 characters.** Use `crypto.randomUUID()` — short test strings will fail validation. | Caught us on the first SDK-based invoke. |
| **`update-agent-runtime` replaces, doesn't merge.** When updating, re-pass every flag you originally used. Especially relevant if you have environment variables (none for Bedrock; some for alternative providers). | Subtle gotcha — would crash a production agent silently. |
| **Tool descriptions are LLM-facing documentation.** The LLM literally reads them to decide whether to call the tool. Sloppy description = poor routing. | Treat them as part of the user-facing surface. |
| **Mobile hotspot uploads are slow for Docker pushes.** Image push of 400MB on hotspot takes 30+ minutes. Multi-stage Docker builds can shrink to ~80MB. | Plan around connection speed. |
| **Free-tier AWS Support cases can sit "Unassigned" for a long time.** Bumping the case with a reply moves it to the top of the queue. | Don't passively wait — escalate after 3-5 days. |
| **The Bedrock latencyMs field is the tell.** When inspecting agent responses, `metadata.metrics.latencyMs` confirms the call went through Bedrock rather than direct provider APIs. Useful for verifying deployment configuration. | Catch infrastructure regressions instantly. |

---

## 9. Quick reference cheatsheet

### Commands I run most often

```cmd
:: Verify AWS setup
aws sts get-caller-identity

:: Verify Bedrock is callable
aws bedrock-runtime invoke-model --model-id us.anthropic.claude-haiku-4-5-20251001-v1:0 --body "{\"anthropic_version\":\"bedrock-2023-05-31\",\"max_tokens\":50,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" --content-type application/json --cli-binary-format raw-in-base64-out --region us-east-1 response.json
type response.json

:: Build TypeScript
npm run build

:: Run local server (no env var needed with Bedrock!)
npm start

:: Test local endpoints
curl http://localhost:8080/ping
curl -X POST http://localhost:8080/invocations -H "Content-Type: application/octet-stream" --data "What is 12 times 7?"

:: Build Docker image (ARM64!)
docker build --platform linux/arm64 -t my-agent-service .

:: Authenticate Docker to ECR (expires every 12 hours)
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com

:: Tag and push to ECR
docker tag my-agent-service:latest <ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com/my-agent-service:latest
docker push <ACCOUNT>.dkr.ecr.us-east-1.amazonaws.com/my-agent-service:latest

:: Check runtime status
aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id <id> --region us-east-1 --query "status" --output text

:: Tail logs from deployed agent
aws logs tail /aws/bedrock-agentcore/runtimes/<id>-DEFAULT --region us-east-1 --follow

:: Test deployed agent (use this, NOT raw aws cli)
npm run invoke

:: Kill stale Node processes (when local server misbehaves)
taskkill /F /IM node.exe
```

### Mental model in one paragraph

> *I wrote a Strands agent in TypeScript with multiple tools. I wrapped it in an Express server that exposes `/ping` and `/invocations`. I packaged the server into a Docker image (`linux/arm64`). I pushed the image to ECR. I created an IAM role that AgentCore assumes to pull the image, write logs, and call Bedrock. I created an AgentCore Runtime that uses the image and the role. Bedrock provides Claude via the role's `bedrock:InvokeModel` permission — no API key anywhere. The runtime exposes an AWS-managed endpoint I can call from anywhere using the AWS SDK. To iterate, I edit code → build → push → update → wait READY → test.*

### Useful URLs

- Strands TypeScript docs: https://strandsagents.com/docs/user-guide/quickstart/typescript/
- AgentCore TypeScript deploy guide: https://strandsagents.com/docs/user-guide/deploy/deploy_to_bedrock_agentcore/typescript/
- Strands SDK source: https://github.com/strands-agents/sdk-typescript
- AgentCore docs: https://docs.aws.amazon.com/bedrock-agentcore/
- Bedrock docs: https://docs.aws.amazon.com/bedrock/
- AWS Service Quotas (Bedrock): https://us-east-1.console.aws.amazon.com/servicequotas/home/services/bedrock/quotas
- AWS Support: https://support.console.aws.amazon.com/support/home

### When something goes wrong

| Error | First thing to check |
|---|---|
| `Too many tokens per day` from Bedrock | Bedrock quota at 0. Open AWS Support case. |
| `on-demand throughput isn't supported` on Bedrock | Wrong model ID — Claude 4.x needs `us.` prefix (inference profile). |
| `exec format error` in CloudWatch logs | Wrong architecture. Rebuild with `--platform linux/arm64`. |
| `no basic auth credentials` on push | Re-run `aws ecr get-login-password` step. |
| `MalformedPolicyDocument` | JSON file has typo. Run `type <file>.json` to inspect. |
| Status stuck at `CREATING` / `UPDATING` | Almost always IAM or container startup. Check CloudWatch logs. |
| `EntityAlreadyExists` | You already created the resource. Skip or use the existing one. |
| Container starts but returns 500 | Check CloudWatch logs for the actual error from your code. |
| `AccessDeniedException` calling Bedrock from deployed agent | IAM role's permissions policy missing `bedrock:InvokeModel`. |
| Local code changes have no effect | Server is running stale code. `taskkill /F /IM node.exe`, then `npm start`. |
| Tool seemingly missing from agent | Server is running stale code. Same fix as above. |
| `runtimeSessionId failed to satisfy constraint` | Session ID under 33 chars. Use `crypto.randomUUID()`. |
| `Invalid base64` from `aws bedrock-agentcore invoke-agent-runtime` | CLI base64 quirks. Switch to `npm run invoke` (uses AWS SDK). |
| `EntityAlreadyExists` on `create-role` | Role exists. Use `get-role` to retrieve the ARN. |

---

## 10. Quick wins for future iterations

Things to do next if continuing on this project:

1. **Multi-stage Docker build** to shrink image ~400MB → ~80MB. 4x faster deploys.
2. **CloudWatch alarms** for error rate and p95 latency.
3. **Real domain tools** instead of calculator/weather demos.
4. **AgentCore Memory** for persistent context across sessions.
5. **AgentCore Identity** if any of the tools need OAuth/API key auth to external services.
6. **Pin Strands SDK version** (`"@strands-agents/sdk": "1.x.x"`) instead of `latest` to avoid breaking changes.
7. **Cross-region failover** — explore using global inference profiles for higher availability.

---

## 11. Appendix A — Alternative provider: Anthropic API direct

This appendix documents an alternative approach using Anthropic's API directly instead of Bedrock. **This is not the preferred path** — Bedrock is strictly better in every dimension except for one scenario: when your AWS account hasn't been provisioned with Bedrock quotas yet and you need to make progress.

### When this is useful

- AWS account is brand new and Bedrock quotas are at 0 awaiting AWS Support
- You're building outside AWS entirely
- You have credits or a relationship with Anthropic directly

### The two changes vs the Bedrock path

Only **two things** change. Everything else stays the same — same Express server, same IAM role (the Bedrock permissions in the role become unused but harmless), same ECR, same Docker, same AgentCore Runtime.

#### Change 1 — Code (`index.ts`)

```typescript
// At top of file:
import 'dotenv/config';  // For local dev — loads ANTHROPIC_API_KEY from .env

// Replace BedrockModel import:
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic';

// And the agent setup:
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Missing ANTHROPIC_API_KEY');
  process.exit(1);
}

const agent = new strands.Agent({
  model: new AnthropicModel({
    apiKey,
    modelId: 'claude-haiku-4-5',  // Note: shorter model IDs, no `us.` prefix
  }),
  tools: [...],
  systemPrompt: '...',
});
```

You'll also need to install the peer dependency:
```cmd
npm install @anthropic-ai/sdk
```

#### Change 2 — Pass the API key when creating/updating the runtime

Add `--environment-variables` to the `create-agent-runtime` or `update-agent-runtime` command:

```cmd
... --environment-variables "ANTHROPIC_API_KEY=sk-ant-api03-..."
```

### Security spectrum for handling the API key

If you go this route, you handle the secret yourself. From worst to best:

| Approach | Verdict |
|---|---|
| Hard-code in `index.ts` | ❌ Catastrophic — key in image, ECR, possibly git |
| `ENV ANTHROPIC_API_KEY=...` in Dockerfile | ❌ Same problem |
| Pass via `--environment-variables` on AgentCore Runtime | ✅ Acceptable for POC |
| AWS Secrets Manager | ✅ Production-grade |

For local development with this approach, use a `.env` file with the dotenv library (NEVER commit `.env` to git — add it to `.gitignore`).

### Why we don't recommend this approach long-term

| Question | Bedrock (preferred) | Anthropic API direct (alternative) |
|---|---|---|
| Per-token cost | Same | Same (identical pricing) |
| Authentication | AWS IAM (no secrets) | API key (you manage it) |
| Secrets to manage | 0 | 1 |
| Where data flows | Stays inside AWS | Leaves AWS to Anthropic |
| Observability | CloudWatch automatic | Manual |
| Compliance posture | Strong | Weaker |
| Future model provider switching | Easy (Bedrock supports many) | Locked to Anthropic |

The only real wins for Anthropic direct: **slightly lower latency** (~50-150ms savings, one less network hop), and **access to newest models sometimes weeks earlier** than they appear on Bedrock.

For most production scenarios in an AWS shop, those wins don't justify the secret-management overhead.

### Switching back from Anthropic to Bedrock

When AWS provisions your Bedrock quotas, swap back:

1. Revert `index.ts` to use `BedrockModel` with the `us.`-prefixed model ID
2. Remove `import 'dotenv/config'` if not needed elsewhere
3. Remove the `--environment-variables` parameter from runtime update commands
4. Optionally revoke the Anthropic API key
5. Optionally `npm uninstall @anthropic-ai/sdk`

That's the entire swap. Same agent, same tools, AWS-native auth.

---

*Notes built iteratively while implementing this POC. Will keep extending as the project evolves.*
