# AgentCore Memory — Concept + Hands-on POC

> Goal: give our Strands agent the ability to **remember** — both within a single
> conversation (short-term) and across conversations/days (long-term) — without
> building or running any database, vector store, or summarization pipeline ourselves.

---

## 1. What it is

**AgentCore Memory is a fully managed memory store for agents.** You write
conversation turns to it; it gives them back to you later. It has two tiers that
work together:

- **Short-term memory** — the raw, verbatim turns of a single conversation
  (a *session*). This is "what was said 3 messages ago." Stored immediately, read
  back immediately. Think: scrollback for one chat.

- **Long-term memory** — durable *insights* extracted from conversations in the
  background: facts about the user, their preferences, running summaries. This is
  "what we know about this user across every chat they've ever had." Generated
  **asynchronously** a short time after you write events, by a **memory strategy**.

Why two tiers? Short-term keeps a single conversation coherent. Long-term lets a
brand-new session start already knowing the user — *without* replaying their entire
history into the model's context window (which would be slow, expensive, and
eventually overflow the context limit).

> One-sentence version: **Memory is a managed store where you append conversation
> turns (short-term) and AWS automatically distills durable facts/summaries from
> them (long-term), all scoped per-user and per-conversation.**

## 2. When to use it (and when not to)

**Use it when:**
- The agent should remember a user between separate invocations/sessions
  ("last time you ordered #35476…", "you prefer metric units").
- A conversation is long enough that you want summaries instead of full history.
- You're on Runtime already and don't want to run your own DynamoDB/vector store.

**You don't need it when:**
- Each request is fully self-contained (our current `calculator` / `weather`
  agent is stateless — it genuinely needs no memory).
- You only need *within-request* state — Strands already keeps the message list
  for a single `agent.invoke()` call. Memory is for state that must survive
  *across* `/invocations` calls.

**Reach for something else when:**
- You need a queryable business database (orders, inventory) — that's a real
  datastore, not agent memory. Memory is for conversational context/insights.

## 3. Key concepts & vocabulary

| Term | Meaning |
|---|---|
| **Memory (resource)** | The top-level container you create once (`CreateMemory`). Has an `id` like `mem-xxxx`. Holds all events + records for many users. |
| **Memory strategy** | Config that defines how long-term insights are extracted. Types: **`SEMANTIC`** (extract facts), **`SUMMARIZATION`** (running summaries), **`USER_PREFERENCE`** (preferences). No strategy = short-term only. |
| **Event** | One write to memory (`CreateEvent`) — usually one or more conversation turns. The unit of short-term memory. |
| **Turn / message** | A single message with a role (`USER` / `ASSISTANT`) and content. |
| **`actorId`** | *Who* the memory is about — the end user (e.g. `user-123`). Long-term insights are grouped by actor. |
| **`sessionId`** | *Which conversation* — groups events into one short-term session (e.g. `chat-2026-06-29-001`). |
| **Namespace** | A path that organizes long-term records, e.g. `/users/{actorId}/facts`. You retrieve by namespace + semantic query. |
| **Retrieval / semantic search** | Ask long-term memory "what's relevant to this query?" and get back the top-k records by similarity score. |

### The lifecycle, end to end

```
  user says something
        │
        ▼
  CreateEvent(memoryId, actorId, sessionId, [turns])   ← short-term: instant
        │
        ├──────────────► readable immediately via "get last K turns"
        │
        ▼  (async, seconds–minutes later, if a strategy is configured)
  memory strategy extracts insights
        │
        ▼
  long-term records appear under a namespace (e.g. /users/user-123/facts)
        │
        ▼
  next session: search_long_term_memories(query) → top-k facts → inject into prompt
```

The crucial timing fact: **long-term extraction is not instant.** Write events,
and the facts show up a little later. Short-term reads are immediate.

## 4. How it fits *our* agent

Today `index.ts` is stateless: every `POST /invocations` builds context from
scratch. To add memory we change the request flow to:

```
POST /invocations  (payload now carries actorId + sessionId + prompt)
   │
   1. RETRIEVE: search long-term memory for this actor, relevant to the prompt
   │            + optionally load last K short-term turns of this session
   │
   2. BUILD CONTEXT: inject those into the system prompt / message history
   │
   3. RUN: agent.invoke(prompt)  ← unchanged Strands call
   │
   4. SAVE: CreateEvent(user turn + assistant turn)  ← feeds future long-term
   │
   └─► return response
```

Two important design choices for the POC:

- **Where do `actorId` / `sessionId` come from?** On real Runtime they come from
  the invocation context (the caller's identity + a session header). For local
  testing we'll accept them in the JSON payload and fall back to defaults.
- **Two ways to wire it** (we'll show both):
  - **(A) Explicit / low-level** — call the memory APIs ourselves via AWS SDK v3.
    More code, but you *see* every read and write. Best for learning, and it
    doesn't depend on experimental Strands glue.
  - **(B) Strands integration** — `createAgentCoreMemoryStores(...)` from the
    `bedrock-agentcore` TS SDK hooks memory into the Strands agent so saves/reads
    happen semi-automatically. Less code, but experimental.

## 5. Hands-on POC

### Step 0 — Prerequisites

```bash
# AWS SDK v3 clients for AgentCore (data plane + control plane)
npm install @aws-sdk/client-bedrock-agentcore @aws-sdk/client-bedrock-agentcore-control

# (Optional, for path B) the convenience SDK with the Strands memory integration
npm install bedrock-agentcore
```

> Pick ONE region for all AgentCore resources. Below uses `us-east-1` to match the
> model region in `index.ts`. If you prefer `us-west-2` (common in AWS Memory
> docs), change it everywhere consistently.

### Step 1 — Create the memory resource (one-time)

You create the memory **once** and reuse its `id` forever. Three ways:

**Option 1 — AgentCore CLI (simplest, what AWS docs use):**
```bash
npm install -g @aws/agentcore
agentcore add memory --name MyAgentMemory --strategies SEMANTIC,SUMMARIZATION
agentcore deploy
agentcore status      # confirm it was created, note the memory id
```
After deploy, the CLI exposes the id as an env var named `MEMORY_MYAGENTMEMORY_ID`
(uppercased resource name) inside the agent runtime.

**Option 2 — AWS Console:** Bedrock AgentCore → Memory → Create, pick the
*Semantic* (and optionally *Summarization*) strategy. Copy the memory id.

**Option 3 — Script it (control-plane SDK), so it's reproducible in our repo:**
see `poc/memory/create-memory.ts` below.

```typescript
// poc/memory/create-memory.ts — run once: `npx tsx poc/memory/create-memory.ts`
import {
  BedrockAgentCoreControlClient,
  CreateMemoryCommand,
  ListMemoriesCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const control = new BedrockAgentCoreControlClient({ region: REGION });

async function main() {
  // Idempotency: don't create a duplicate if one with our name already exists.
  const existing = await control.send(new ListMemoriesCommand({}));
  const found = existing.memories?.find((m) => m.name === 'MyAgentMemory');
  if (found) {
    console.log('Memory already exists:', found.id);
    return;
  }

  const res = await control.send(
    new CreateMemoryCommand({
      name: 'MyAgentMemory',
      description: 'POC memory for the Strands+AgentCore agent',
      // Strategies enable LONG-term extraction. Omit this whole block for
      // short-term-only memory.
      memoryStrategies: [
        { semanticMemoryStrategy: { name: 'facts' } },
        { summaryMemoryStrategy: { name: 'summaries' } },
      ],
      // Optional: how long raw short-term events are retained (days).
      eventExpiryDuration: 90,
    }),
  );
  console.log('Created memory:', res.memory?.id);
  console.log('➡️  Put this id in your .env as MEMORY_ID=', res.memory?.id);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

> ⚠️ Exact field names on `CreateMemoryCommand` (`memoryStrategies` vs
> `memoryStrategy`, the strategy sub-objects) can shift between SDK versions
> because this API is young. If the compiler complains, run
> `npx tsc` and let the types tell you the current shape, or check
> `node_modules/@aws-sdk/client-bedrock-agentcore-control`. The *concepts*
> (a memory + zero-or-more strategies) are stable; the field spelling may not be.

Add the id to `.env`:
```
MEMORY_ID=mem-xxxxxxxx
```

### Step 2 — A small memory helper (Path A: explicit, recommended for learning)

```typescript
// poc/memory/memory.ts — thin wrapper over the data-plane client.
import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  ListEventsCommand,
  RetrieveMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const MEMORY_ID = process.env.MEMORY_ID!;
const client = new BedrockAgentCoreClient({ region: REGION });

export type Turn = { role: 'USER' | 'ASSISTANT'; text: string };

/** SHORT-TERM WRITE: append conversation turns to a session. Instant. */
export async function saveTurns(
  actorId: string,
  sessionId: string,
  turns: Turn[],
): Promise<void> {
  await client.send(
    new CreateEventCommand({
      memoryId: MEMORY_ID,
      actorId,
      sessionId,
      payload: turns.map((t) => ({
        conversational: { role: t.role, content: { text: t.text } },
      })),
    }),
  );
}

/** SHORT-TERM READ: most recent turns of THIS session. Instant. */
export async function getRecentTurns(
  actorId: string,
  sessionId: string,
  maxResults = 10,
): Promise<Turn[]> {
  const res = await client.send(
    new ListEventsCommand({ memoryId: MEMORY_ID, actorId, sessionId, maxResults }),
  );
  const turns: Turn[] = [];
  for (const ev of res.events ?? []) {
    for (const p of ev.payload ?? []) {
      const c = (p as any).conversational;
      if (c?.content?.text) turns.push({ role: c.role, text: c.content.text });
    }
  }
  return turns;
}

/** LONG-TERM READ: semantic search across everything we know about this actor. */
export async function recallFacts(
  actorId: string,
  query: string,
  topK = 3,
): Promise<string[]> {
  const res = await client.send(
    new RetrieveMemoryRecordsCommand({
      memoryId: MEMORY_ID,
      namespace: `/users/${actorId}/facts`,
      searchCriteria: { searchQuery: query, topK },
    }),
  );
  return (res.memoryRecords ?? [])
    .map((r) => (r as any).content?.text ?? '')
    .filter(Boolean);
}
```

> Same caveat as Step 1: `payload` / `conversational` / `searchCriteria` field
> spellings track the SDK version. The shape above matches the documented
> concepts (events carry conversational payloads; retrieval takes a namespace +
> query + topK). Verify against your installed types; the structure won't surprise
> you even if a key name does.

### Step 3 — Wire it into `index.ts`

Minimal changes to the existing `/invocations` handler. The diff in spirit:

```typescript
// near the top
import { saveTurns, getRecentTurns, recallFacts } from './poc/memory/memory';

app.post(
  '/invocations',
  express.raw({ type: '*/*', limit: '10mb' }),
  async (req: Request, res: Response) => {
    try {
      // Payload is now JSON: { prompt, actorId?, sessionId? }
      const body = JSON.parse(new TextDecoder().decode(req.body));
      const prompt: string = body.prompt;
      const actorId: string = body.actorId ?? 'demo-user';
      const sessionId: string = body.sessionId ?? 'demo-session';

      // 1) RECALL long-term facts relevant to this prompt (cross-session memory)
      const facts = await recallFacts(actorId, prompt).catch(() => []);

      // 2) BUILD a memory-aware system prompt
      const memoryBlock =
        facts.length > 0
          ? `\n\nWhat you already know about this user:\n- ${facts.join('\n- ')}`
          : '';

      // Per-request agent so we can inject per-user memory into the system prompt.
      const agent = new strands.Agent({
        model: new BedrockModel({
          region: 'us-east-1',
          modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        }),
        tools: [calculatorTool, weatherTool],
        systemPrompt:
          'You are a helpful assistant. Use the calculator and weather tools when relevant.' +
          memoryBlock,
      });

      // 3) RUN the agent (unchanged Strands call)
      const response = await agent.invoke(prompt);
      const answer = String((response as any).output ?? response);

      // 4) SAVE this turn so it becomes future short-term + long-term memory
      await saveTurns(actorId, sessionId, [
        { role: 'USER', text: prompt },
        { role: 'ASSISTANT', text: answer },
      ]).catch((e) => console.error('saveTurns failed (non-fatal):', e));

      return res.json({ response });
    } catch (err) {
      console.error('Error processing /invocations request:', err);
      return res
        .status(500)
        .json({ error: 'Internal server error', details: String(err) });
    }
  },
);
```

> Note we now build the `Agent` **inside** the handler. That's deliberate: the
> system prompt is personalized per user/request. (Tools and model are cheap to
> re-declare; if you want, hoist the tool definitions out and keep only the
> `new Agent` call inside.)

### Step 4 — Test the memory loop locally

```bash
npx tsx poc/memory/create-memory.ts          # one-time, copy id to .env
npm run build && node dist/index.js           # or however you start the server

# First conversation — teach it something
curl -s localhost:8080/invocations \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Remember that I always want temperatures in Fahrenheit.","actorId":"kiran","sessionId":"s1"}'

# ... wait ~30-60s for long-term extraction ...

# New session, same user — it should recall the preference
curl -s localhost:8080/invocations \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"What is the weather in Tokyo?","actorId":"kiran","sessionId":"s2"}'
# Expect the answer to volunteer Fahrenheit because recallFacts surfaced the preference.
```

### Path B — Strands integration (less code, experimental)

Instead of calling save/recall yourself, let the SDK hook memory into the agent:

```typescript
import { createAgentCoreMemoryStores } from 'bedrock-agentcore/experimental/memory/strands';

const stores = createAgentCoreMemoryStores({
  memoryId: process.env.MEMORY_ID!,
  actorId,
  sessionId,
  namespaces: [
    { namespace: '/users/{actorId}/facts', writable: true },
    { namespace: '/users/{actorId}/preferences' },
  ],
  extraction: true, // auto-trigger long-term extraction
});
// then attach `stores` to the Strands Agent per that SDK's session-manager API,
// and call store.addMessages(...) / store.search(...) / store.flush().
```

Use Path B once you're comfortable with the concepts from Path A. The explicit
path makes the four steps (recall → build → run → save) visible; the integration
hides them, which is great for production but worse for *learning*.

## 6. Gotchas, limits, pricing

- **Long-term is eventually-consistent.** Facts appear seconds-to-minutes after
  `CreateEvent`. Don't write a fact and immediately assert it's retrievable in a
  test — add a wait, or test short-term reads (which *are* immediate) separately.
- **No strategy = no long-term.** If you create a memory without a strategy you
  only get short-term. Add a `SEMANTIC` / `SUMMARIZATION` / `USER_PREFERENCE`
  strategy to get extraction.
- **`actorId` / `sessionId` discipline is everything.** Wrong actorId = you leak
  one user's memory into another's, or fail to recall. Treat actorId as the user's
  stable id (not their display name), and sessionId as one conversation thread.
- **Namespaces must match between write and read.** If extraction writes to
  `/users/{actorId}/facts`, recall from the *same* path. Mismatched namespaces =
  silent empty results.
- **Region pinning.** Memory resource, data-plane calls, and (ideally) your model
  should share a region. Cross-region works but adds latency and confusion.
- **Cost model.** You pay for events stored, long-term extraction (it runs models
  under the hood), and retrieval. It's usage-based — a POC with a handful of users
  is cheap, but background extraction on high-volume chat is a real line item.
  Check current pricing on the AgentCore pricing page before going to volume.
- **Cleanup.** Delete the memory resource when done with the POC
  (`agentcore remove memory --name MyAgentMemory && agentcore deploy`, or
  `DeleteMemoryCommand`) so you stop paying for retained events.
- **SDK churn.** The TS Memory surface is experimental and the AWS SDK v3 field
  names are young. The *concepts* in this doc are stable; verify exact field
  spellings against your installed `@aws-sdk/client-bedrock-agentcore[-control]`
  types before shipping.

## 7. Checkpoint — what you should now be able to explain

- The difference between short-term and long-term memory, and *why both exist*.
- What `actorId`, `sessionId`, a memory strategy, and a namespace each do.
- The four-step request flow (recall → build context → run → save).
- Why long-term retrieval is asynchronous and what that means for testing.

Next service: **Gateway** (`02-gateway.md`) — turning APIs into agent tools.

---

### Sources
- [Add memory to your AgentCore agent](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html)
- [Get started with AgentCore Memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-get-started.html)
- [Memory types](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-types.html)
- [Store and use short-term memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/short-term-memory-operations.html)
- [AgentCore Memory: building context-aware agents (AWS blog)](https://aws.amazon.com/blogs/machine-learning/amazon-bedrock-agentcore-memory-building-context-aware-agents/)
- [bedrock-agentcore TypeScript SDK](https://github.com/aws/bedrock-agentcore-sdk-typescript)
