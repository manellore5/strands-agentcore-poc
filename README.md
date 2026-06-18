# Strands TypeScript Agent on Amazon Bedrock AgentCore

A minimal, production-shaped example of a Strands Agent (TypeScript) deployed to Amazon Bedrock AgentCore Runtime.

## What this is and why it exists

### Why Strands?

Strands Agents is an open-source SDK from AWS for building AI agents. Without a framework like Strands you would write the "agent loop" yourself — calling the LLM, parsing tool calls out of its response, executing the tools, feeding the results back, looping until the model stops, formatting messages, handling streaming, retries, and conversation state. Strands gives you all of that in a few lines of code.

Concretely, Strands provides:

- A clean `Agent` class that runs the reasoning loop
- A `tool()` helper that turns a TypeScript function into something the LLM can invoke, with Zod-based runtime validation and type inference
- Pluggable model providers (Bedrock, OpenAI, Anthropic direct, Ollama, etc.) so you can swap LLMs without rewriting the agent
- Native MCP (Model Context Protocol) support
- Streaming, structured output, multi-agent patterns

You should use Strands whenever you want an LLM that can *take actions*, not just chat — looking things up, calling APIs, processing files. Without it you would build the same plumbing yourself, badly.

### Why AgentCore?

Amazon Bedrock AgentCore is the production hosting and infrastructure platform for agents. Strands builds the agent; AgentCore is where you deploy and run it at scale. AgentCore gives you:

- **Runtime** — secure, session-isolated container hosting (this is what we use here)
- **Memory** — persistent conversation memory across sessions
- **Identity** — managed API keys and OAuth tokens for tools that need auth
- **Gateway** — turn any API into an agent tool
- **Code Interpreter** — sandboxed code execution
- **Browser** — cloud-based web automation
- **Observability** — CloudWatch logs, metrics, X-Ray traces, built in

Running an agent on your laptop is easy. Running one for thousands of users — securely, with session isolation, persistent memory, auth, and observability — is hard. AgentCore handles that infrastructure so you don't reinvent it.

### How they fit together

Strands is the framework you write your agent in. AgentCore is the AWS platform you deploy that agent to. The contract between them is dead simple: AgentCore Runtime is a container host that expects two HTTP endpoints, `GET /ping` and `POST /invocations`. As long as your container speaks that contract, AgentCore takes care of everything else.

---

## What's in this repo

```
my-agent-service/
├── index.ts              # The Strands agent + Express server (the actual code)
├── invoke.ts             # Test client for the deployed agent
├── package.json          # Dependencies and npm scripts
├── tsconfig.json         # TypeScript compiler config
├── Dockerfile            # Container image definition (ARM64 for AgentCore)
├── .dockerignore         # Files to exclude from the Docker build
├── create-iam-role.sh    # One-shot IAM role setup
└── README.md             # You are here
```

## Prerequisites

- Node.js 20+
- Docker Desktop installed and running
- AWS CLI configured (`aws configure`)
- An AWS account with:
  - Bedrock model access enabled (request access to Claude in the Bedrock console)
  - Permissions to create AgentCore runtimes, ECR repos, and IAM roles

This project targets **`us-east-1`** throughout. Change `REGION` in `index.ts`, `invoke.ts`, and the deployment commands if you want a different region.

---

## Local development

```bash
# 1. Install dependencies
npm install

# 2. Build TypeScript -> dist/
npm run build

# 3. Run the server
npm start
```

In a separate terminal:

```bash
# Health check
curl http://localhost:8080/ping

# Send a prompt (note the binary content-type and stdin trick)
echo -n "What is 12 times 7?" | curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/octet-stream" \
  --data-binary @-
```

You should see a JSON response with the agent's answer (`84`).

---

## Deploying to AgentCore Runtime

### Step 1 — Create the IAM role (do this once)

```bash
chmod +x create-iam-role.sh
./create-iam-role.sh
```

Save the `Role ARN` it prints.

### Step 2 — Set environment variables

```bash
export ACCOUNTID=$(aws sts get-caller-identity --query Account --output text)
export AWS_REGION=us-east-1
export ROLE_ARN=$(aws iam get-role --role-name BedrockAgentCoreRuntimeRole --query 'Role.Arn' --output text)
export ECR_REPO=my-agent-service
```

### Step 3 — Create an ECR repository

```bash
aws ecr create-repository \
  --repository-name ${ECR_REPO} \
  --region ${AWS_REGION}
```

(Skip this if the repo already exists.)

### Step 4 — Build and push the Docker image

```bash
# Authenticate Docker against ECR
aws ecr get-login-password --region ${AWS_REGION} | \
  docker login --username AWS --password-stdin \
  ${ACCOUNTID}.dkr.ecr.${AWS_REGION}.amazonaws.com

# Build (ARM64!) and push
docker build -t ${ECR_REPO} .
docker tag ${ECR_REPO}:latest \
  ${ACCOUNTID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}:latest
docker push \
  ${ACCOUNTID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}:latest
```

### Step 5 — Create the AgentCore Runtime

```bash
aws bedrock-agentcore-control create-agent-runtime \
  --agent-runtime-name my_agent_service \
  --agent-runtime-artifact containerConfiguration={containerUri=${ACCOUNTID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}:latest} \
  --role-arn ${ROLE_ARN} \
  --network-configuration networkMode=PUBLIC \
  --protocol-configuration serverProtocol=HTTP \
  --region ${AWS_REGION}
```

Note the `agentRuntimeId` in the output — you'll need it.

### Step 6 — Wait for status `READY`

```bash
aws bedrock-agentcore-control get-agent-runtime \
  --agent-runtime-id <your-runtime-id> \
  --region ${AWS_REGION} \
  --query 'status' \
  --output text
```

Re-run every ~30s until it prints `READY` (usually 1–2 minutes).

### Step 7 — Test it

1. Open `invoke.ts`
2. Set `YOUR_ACCOUNT_ID` and `YOUR_RUNTIME_ID`
3. Run:

```bash
npx tsx invoke.ts
```

You should see a response like:

```
Response: {"response":{"type":"agentResult","stopReason":"endTurn","lastMessage":{"type":"message","role":"assistant","content":[{"type":"textBlock","text":"The result of 5 plus 3 is 8."}]}}}
```

---

## Updating after code changes

```bash
# Rebuild and re-push
docker build -t ${ACCOUNTID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}:latest . --no-cache
docker push ${ACCOUNTID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}:latest

# Tell AgentCore to pick up the new image
aws bedrock-agentcore-control update-agent-runtime \
  --agent-runtime-id "<your-runtime-id>" \
  --agent-runtime-artifact "{\"containerConfiguration\": {\"containerUri\": \"${ACCOUNTID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}:latest\"}}" \
  --role-arn "${ROLE_ARN}" \
  --network-configuration "{\"networkMode\": \"PUBLIC\"}" \
  --protocol-configuration serverProtocol=HTTP \
  --region ${AWS_REGION}
```

## Viewing logs

```bash
aws logs tail /aws/bedrock-agentcore/runtimes/<your-runtime-id>-DEFAULT \
  --region ${AWS_REGION} \
  --since 10m \
  --follow
```

---

## Common gotchas

- **"exec format error" in the runtime log** — You built for `amd64` instead of `arm64`. Rebuild with the `--platform=linux/arm64` directive (already in the Dockerfile, but make sure Docker Buildx is using it on Apple Silicon and especially on x86 Linux/Windows machines).
- **`AccessDeniedException` calling Bedrock** — You haven't enabled model access for the Claude model in the Bedrock console. Go to *Bedrock → Model access → Manage model access* and request access.
- **Runtime stuck in `CREATING`** — Almost always an IAM problem. Check the runtime's logs and the IAM role's trust policy.
- **TypeScript SDK is in preview** — Breaking changes are expected. Pin `@strands-agents/sdk` to a specific version once you've got something working.

## References

- Strands TypeScript quickstart: https://strandsagents.com/docs/user-guide/quickstart/typescript/
- AgentCore TypeScript deployment guide: https://strandsagents.com/docs/user-guide/deploy/deploy_to_bedrock_agentcore/typescript/
- Strands SDK source: https://github.com/strands-agents/sdk-typescript
- AgentCore docs: https://docs.aws.amazon.com/bedrock-agentcore/
