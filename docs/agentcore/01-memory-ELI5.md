# AgentCore Memory — ELI5 (Explain Like I'm 5)

> Plain-English companion to [`01-memory.md`](01-memory.md). Read this FIRST to build
> intuition, then the main doc for the precise API and the POC. Zero jargon up front;
> every real term is introduced only after you've felt *why* it exists.

---

## 1. The problem memory solves

Imagine you call a customer-support helpline. Every time you call, a **brand-new agent**
picks up who has **never heard of you**. You re-explain your name, your problem, your
order number — *every single time*. Annoying, right?

That's exactly what our agent (`index.ts`) is like **right now**. Every time someone
sends a message to `/invocations`, the AI wakes up with total amnesia. It answers the
one question, then forgets everything the instant it replies.

**Memory** turns that forgetful helpline into a helpful friend who *remembers you*.

The twist: there are **two different kinds of remembering**, and humans use both.
AgentCore copies how humans do it.

## 2. The two kinds of memory (the heart of everything)

### Short-term memory = "what we just said"

You're **mid-conversation**. You say "My dog is named Rex." Two sentences later the
other person asks "How old is Rex?" — they remembered "Rex" because it was *just said*.

That's **short-term memory**: holding the thread of **one ongoing conversation**.
- It's the **exact words**, kept in order.
- It only lasts for **this one chat**.
- It's available **instantly** — the moment you say something, it can be read back.

> 🟢 Think: the **scrollback** in a single chat window.

### Long-term memory = "what I know about you"

Now picture a friend you've known for **years**. They don't remember every word of every
conversation — that's impossible. Their brain **quietly distilled** thousands of chats
into a few durable facts:
- "She's vegetarian."
- "He hates phone calls, prefers texting."
- "Their kid's name is Maya."

They don't remember *the sentence where you said you're vegetarian* — they just **know
the fact** now. That's **long-term memory**: durable **insights** pulled from many
conversations, surviving across **all** your chats.

> 🟣 Think: the **summary your friend's brain keeps about you.**

## 3. Why two kinds? Why not just remember everything?

You *could* replay the **entire history** of every past conversation into the AI before
each reply. It breaks for three reasons:

1. **It won't fit.** An AI can only hold so much text at once (its *context window*).
   Eventually the history is too big — like re-reading your whole diary before answering
   one text.
2. **It's slow and expensive.** You pay (money + time) for every word the AI reads.
   Re-reading 10,000 old messages to answer "what's the weather?" is absurd.
3. **It's noise.** 99% of old chatter is irrelevant to the current question. You want
   the *gist*, not the transcript.

So memory splits the job:
- **Short-term** keeps *this* conversation coherent (small, exact, instant).
- **Long-term** keeps the *durable gist* of everything (small, distilled, searchable).

Together they *feel* like "remembers everything" without the cost of literally storing
everything in the AI's head.

## 4. How long-term memory actually gets created (the surprising part)

Go slow here — this is the bit everyone trips on.

When you save a conversation, you **only write the raw words** (short-term). You do
**not** write facts directly. Instead:

> A little robot works in the background. Every so often it reads the raw conversations
> you saved, thinks "what's worth remembering long-term?", and **writes down the
> distilled facts itself.**

That background robot is a **memory strategy**. You *configure* it once when you create
the memory ("extract facts" / "keep a running summary"). Then it runs automatically.

Two consequences that feel weird but matter a lot:

1. **It's not instant.** You save a conversation; the facts appear **seconds to minutes
   later**, because the robot runs in the background. → *Don't save a fact and test for
   it one second later.*
2. **No robot = no facts.** Create a memory **without** a strategy and you get *only*
   short-term. The raw words are stored, but nobody distills them. → *This is the
   "no strategy = no long-term" gotcha.*

## 5. The filing-cabinet model (actorId, sessionId, namespace)

One memory store serves **many users** and **many conversations**. How does it not mix
them up? Picture a filing cabinet:

- **`actorId` = WHO.** One drawer per person. `actorId = "kiran"` is *your* drawer. Your
  long-term facts go in *your* drawer, never leak into someone else's.
  → Use a **stable ID**, not a display name ("kiran" the id, not "Kiran M." which could change).

- **`sessionId` = WHICH CONVERSATION.** Inside your drawer, one folder per chat.
  `"s1"` is Monday's chat; `"s2"` is Tuesday's. Short-term memory lives in one folder.
  → A new `sessionId` = a fresh conversation thread.

- **`namespace` = WHICH SHELF the facts sit on.** Long-term facts are organized on
  labeled shelves like `/users/kiran/facts` or `/users/kiran/preferences`.
  → **The catch:** read facts off the **same shelf** the robot wrote them to. Write to
  `/facts`, read from `/facts`. Wrong shelf = you find nothing, and it fails *silently*
  (no error, just empty). This is the "namespaces must match" gotcha.

## 6. One trip through our agent

You've used the agent before and once said you like Fahrenheit. Today you ask:
*"What's the weather in Tokyo?"*

```
1. RECALL   → Open Kiran's drawer, search the /facts shelf for anything
              relevant to "weather". Find: "prefers Fahrenheit."

2. BUILD    → Quietly add to the AI's instructions:
              "Things you know about this user: prefers Fahrenheit."

3. RUN      → The AI answers "Tokyo is 72°F" — in Fahrenheit, without
              you re-telling it. (This is the normal agent.invoke()
              you already have.)

4. SAVE     → Write today's two lines (your question + its answer) into
              this conversation's folder. Later the background robot may
              distill new facts from it.
```

Steps 1, 2, 4 are the *new* parts. Step 3 is your existing agent, unchanged.

---

# Part II — Going deeper on the tricky pieces

You asked to go deep. Here are the three things people ask about most, still in ELI5
style but with more detail.

## 7. What a memory *strategy* actually does (the three robots)

A **strategy** is the background robot that turns raw conversation into long-term
records. There are different *kinds* of robot because there are different *kinds* of
thing worth remembering. You can turn on one, some, or all of them.

### 🤖 SEMANTIC strategy — "the fact collector"

Reads conversations and extracts **standalone facts**.

- You said: *"I just moved to Austin and I work as a nurse."*
- It stores:
  - `"User lives in Austin."`
  - `"User works as a nurse."`

Each fact is a little self-contained nugget. Great for: personal details, context about
the user's world, things that are *true* and worth recalling later. The word "semantic"
just means "by meaning" — more on that in §8.

### 🤖 SUMMARIZATION strategy — "the note-taker"

Doesn't pull out separate facts — it keeps a **running summary** of the conversation,
rewritten as the chat grows.

- After a 30-message support chat, instead of 30 messages it keeps:
  - `"Customer reported order #35476 never arrived; agent opened a refund case; customer agreed to wait 3 business days."`

Great for: long conversations where you want the *story so far* without replaying every
line. This is the trick that keeps long chats from overflowing the AI's context window.

### 🤖 USER_PREFERENCE strategy — "the preferences keeper"

Specifically hunts for **how the user likes things done** — settings and tastes.

- You said: *"Ugh, always give me temperatures in Fahrenheit and keep answers short."*
- It stores:
  - `"Prefers Fahrenheit."`
  - `"Prefers concise answers."`

Great for: personalization. (Could a SEMANTIC robot catch these too? Sometimes — but a
dedicated preference robot is tuned to spot "I like / I prefer / always / never" style
statements.)

### How to picture them together

```
        Raw conversation (short-term)
                  │
   ┌──────────────┼───────────────────┐
   ▼              ▼                    ▼
[SEMANTIC]   [SUMMARIZATION]   [USER_PREFERENCE]
 facts         a summary         preferences
   │              │                    │
   ▼              ▼                    ▼
 /facts        /summaries        /preferences     ← different shelves (namespaces)
```

You pick which robots to hire when you **create the memory**
(`--strategies SEMANTIC,SUMMARIZATION` in the CLI, or the `memoryStrategies` list in
code). Each robot writes to its own namespace shelf, and you recall from the shelf you
care about.

> **Mental rule of thumb:**
> SEMANTIC = *facts about the user's world.*
> SUMMARIZATION = *the gist of the conversation.*
> USER_PREFERENCE = *how the user wants to be treated.*

## 8. What "semantic search" means when recalling facts

When you recall long-term memory, you don't look things up by exact keyword like
`Ctrl+F`. You search **by meaning**. That's what "semantic" means.

### The problem with keyword search

Say the stored fact is: `"User prefers temperatures in Fahrenheit."`
Now the user asks: *"How hot is it in Tokyo?"*

A keyword search for "Fahrenheit" finds nothing — the user didn't *say* "Fahrenheit."
But *by meaning*, "how hot" is obviously related to "temperature preference." Keyword
search misses it. Semantic search catches it.

### How semantic search works (ELI5)

Imagine every sentence gets placed as a **dot on a giant map of meaning**. Sentences
that *mean* similar things land **near each other**, even if they use different words:

```
        (cold)
           •  "I like it chilly"
                                  • "give me Fahrenheit"
   • "what's the temperature?"   • "how hot is it?"        ← these two are NEIGHBORS
                                                              (same meaning, different words)

                        • "my dog is named Rex"   ← way over here, unrelated
```

When you search, your question becomes a dot too, and the system returns the **nearest
neighbors** — the stored facts closest *in meaning*. (Under the hood those "map
coordinates" are called *embeddings*, but you don't need that word to use it.)

### The two knobs you'll see

- **`topK`** — "give me the **K nearest** dots." `topK = 3` = the 3 most relevant facts.
  Keeps you from dumping the user's entire history into the prompt.
- **`minScore` / relevance score** — "**only** if it's at least *this* close." Filters
  out weak matches. Without it, even a barely-related fact ("my dog is Rex") might sneak
  in as the 3rd result when nothing better exists.

> Why this matters for us: in the POC, `recallFacts(actorId, prompt)` does exactly this —
> turns the user's current message into a search and pulls the few most *meaningfully*
> related facts, then we paste them into the system prompt.

## 9. How memory is different from a normal database

Tempting to think "isn't this just a database?" Here's the honest difference.

| | Normal database | AgentCore Memory |
|---|---|---|
| **You look things up by** | Exact keys ("row where id = 35476") | **Meaning** ("facts related to this question") |
| **You write** | Exactly the rows you want | **Raw conversation**; the system *derives* the facts for you |
| **Who creates the insights** | You do, with code | A **background strategy robot** does it automatically |
| **What it's for** | Source-of-truth business data (orders, inventory, payments) | **Conversational context & what-we-know-about-the-user** |
| **Shape of data** | Rigid tables/columns you designed | Free-form facts/summaries in meaning-space |

The clean rule:

- Need to know **"did order #35476 ship?"** → that's a **database** question. Exact,
  authoritative, business data. Memory is the wrong tool.
- Need to know **"what does this user generally care about / what have we been talking
  about?"** → that's a **memory** question. Fuzzy, conversational, by-meaning.

A real app uses **both**: a database for the orders, and Memory so the agent remembers
*you* across conversations. They're teammates, not rivals.

## 10. The 7-sentence summary

1. Our agent currently forgets everything between messages.
2. **Short-term memory** = the exact words of *this* chat, available instantly.
3. **Long-term memory** = durable facts/summaries about the user, distilled
   automatically in the background, surviving across all chats.
4. The thing that does the distilling is a **strategy** — SEMANTIC (facts),
   SUMMARIZATION (running gist), USER_PREFERENCE (how they like things).
5. Long-term is **not instant** (background) and **needs a strategy** (no robot, no facts).
6. You file everything by **who** (`actorId`) and **which chat** (`sessionId`); facts
   live on **shelves** (`namespaces`) you must read back from consistently; recall is by
   **meaning** (semantic search), tuned with `topK` and `minScore`.
7. Each request becomes: **recall** facts → **add** them to the prompt → **run** the
   agent → **save** the new turns. Memory and a real database are teammates, not rivals.

---

## Self-check (can you answer these in your own words?)

1. Why can't we just feed the AI every past message instead of using long-term memory?
2. You save a fact and it's not retrievable 2 seconds later — bug, or expected? Why?
3. A user's preference isn't being recalled even though they stated it. Name two likely
   causes from this doc.
4. When would you reach for a real database instead of Memory?
5. In one sentence each: SEMANTIC vs SUMMARIZATION vs USER_PREFERENCE.

(Answers are all above — §3, §4, §5+§7, §9, §7.)

---

➡️ Once this clicks, go to [`01-memory.md`](01-memory.md) §5 for the hands-on POC, or
say "resume the Memory POC" to scaffold and run it.
