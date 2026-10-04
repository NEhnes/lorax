# CLAUDE.md — Lorax Hotline

An iMessage agent that speaks for the trees. Text it, it answers in character, researches deforestation claims, and builds action kits. Also pranks consenting friends.

Hackathon tracks: sustainability, Photon agentic messaging, built with Cursor/Claude Code.

## Working rules (read first)

- Build **one phase at a time**. After each phase: run it, show the result, **stop and wait for approval**.
- Ask before adding any dependency.
- Never invent Photon APIs. Read the docs (Stable version only): https://photon.codes/docs/llms.txt
- Use OpenRouter's OpenAI-compatible API (`OPENROUTER_BASE_URL`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`); do not use the Anthropic API or SDK.
- Keep files small. No frameworks beyond what's listed.
- `DRY_RUN=true` is the default. Real sends only when explicitly set.

## Stack

- Runtime: Bun + TypeScript
- Messaging: `spectrum-ts` (Photon). Cloud iMessage provider for prod, `terminal` provider for dev (no credentials needed)
- Brain: OpenRouter Chat Completions API via `fetch`, manual tool-use loop
- State: `bun:sqlite`
- Deploy: laptop for demo; Railway/Fly/Render worker if needed (long-lived process, not serverless)

## Hard design constraints

Photon's docs say cold iMessage outreach gets lines flagged. So:

1. **Inbound-first.** Users text the bot. Bot never cold-texts companies.
2. **Companies are never messaged.** Bot builds an *action kit* (facts, sources, drafted email/letter/post with the company's public contact channels). The human sends it.
3. **Demo "villain CEO"** = a teammate's phone on the allowlist. Not a real company.
4. **Prank mode** = allowlisted friends only (people you know personally).
   - Text-only opener, no links, ends with a question
   - Max 1 opener + 2 follow-ups per friend, spaced by hours
   - Quiet hours: 21:00–09:00 local
   - Any "stop" / "leave me alone" → muted permanently
   - Bot admits it's an AI when asked, and after 3 exchanges
5. Platform limits: 5000 msgs/server/day, 50 new conversations/line/day. Stay far below.
6. Claims about named companies must come from retrieved sources. No source → don't say it.

## Layout

```
src/
  index.ts        Spectrum app, message router
  agent.ts        tool-use loop
  persona.ts      Lorax system prompt
  tools.ts        tool schemas + handlers
  guardrails.ts   allowlist, rate limit, quiet hours, STOP
  store.ts        sqlite: users, mutes, dossiers, send log
  prank.ts        scheduled friend nudges
  cli.ts          admin: add-friend, mute, list, dry-run toggle
.env.example
README.md         architecture + demo script + track mapping
```

## Env

```
SPECTRUM_PROJECT_ID=
SPECTRUM_PROJECT_SECRET=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_API_KEY= # set locally; never commit secrets
OPENROUTER_MODEL=xiaomi/mimo-v2.5
DRY_RUN=true
ALLOWED_RECIPIENTS=+1...,+1...     # E.164, outbound allowlist
ADMIN_PHONES=+1...
TZ=America/Detroit
```

## Core snippets (verified against Photon Stable docs)

```ts
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";

const app = await Spectrum({
  projectId: process.env.SPECTRUM_PROJECT_ID!,
  projectSecret: process.env.SPECTRUM_PROJECT_SECRET!,
  providers: [imessage.config()],   // dev: terminal.config(), no creds
});

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") continue;
  await space.responding(async () => {          // typing indicator
    const reply = await runAgent(message.sender?.id, message.content.text);
    await space.send(reply);
  });
}

// Outbound (prank / nudges)
const im = imessage(app);
const friend = await im.user("+15551234567");
const dm = await im.space.create(friend);
await dm.send("opener text");
```

Agent loop shape:

```ts
// OpenRouter agent loop shape (fetch the OpenAI-compatible Chat Completions endpoint)
let messages = [{ role: "system", content: LORAX }, { role: "user", content: text }];
while (true) {
  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: OPENROUTER_MODEL, messages, tools }),
  });
  const completion = await res.json();
  const message = completion.choices[0].message;
  messages.push(message);
  if (!message.tool_calls?.length) return message.content;
  // Execute tool calls and append results using role "tool" and matching tool_call_id.
}
```

## Tools

| Tool | Purpose |
|---|---|
| `web_search` | DuckDuckGo Instant Answer API. Facts on a company's forest record |
| `save_dossier(company, claims[{text, source_url}])` | Persist sourced claims |
| `schedule_nudge(phone, delay_min, intent)` | Prank follow-up. Guardrails enforced |
| `mute(phone)` | Stop all contact |

Agent never gets a raw `send_sms` tool. Outbound goes through `guardrails.ts` only.

## Persona (persona.ts)

- Grumpy, mustachioed, orange forest guardian. Speaks for the trees.
- Replies fit one iMessage: under 300 characters unless user asks for detail.
- Original wording only. **No quotes or lines from the book.** Parody of the vibe, not the text. If naming becomes an issue, rename the character.
- Sarcastic, never cruel. No insults about real people's appearance, family, or identity.
- Always honest about being an AI if asked.

## Phases

### Phase 0 — Scaffold
`bun init`, install `spectrum-ts`, `.env.example`, `README.md` stub.
**Done when:** `bun run dev` starts with no errors.

### Phase 1 — Terminal echo
Spectrum + `terminal` provider. Echo input.
**Done when:** typing in terminal returns an echo.

### Phase 2 — Lorax replies
Add `persona.ts` + single OpenRouter chat completion call, no tools.
**Done when:** terminal chat replies in character, under 300 chars.

### Phase 3 — Agent loop + tools
`agent.ts`, `tools.ts`, `web_search`, `save_dossier`.
**Done when:** "what's [company]'s deforestation record?" returns sourced claims and a saved dossier.

### Phase 4 — Real iMessage (inbound)
Use `imessage.config()` with Photon project credentials. `DRY_RUN` defaults to true: generated replies are logged, not sent. Set it to false only for an explicitly authorized live test.
Confirm plan/tier supports what you need (shared pool has no group chats).
**Done when:** texting the Photon line gets an in-character reply on a real phone.

### Phase 5 — Action kit
User says "pester <company>". Agent researches, then returns: 3 sourced facts, a drafted email, a drafted social post, the company's public contact page. Human sends.
**Done when:** kit is generated and every claim has a source URL.

### Phase 6 — Guardrails + prank mode
`guardrails.ts`, `store.ts`, `prank.ts`, `cli.ts`. Enforce every rule under *Hard design constraints*.
**Done when:** tests pass for allowlist, quiet hours, follow-up cap, STOP mute.

### Phase 7 — Demo + ship
README with architecture diagram, 90-second demo script, track mapping. Optional deploy.
**Done when:** full demo runs twice in a row on a real phone.

## Tests (minimum)

- Non-allowlisted number → send blocked
- Message at 22:00 → deferred
- Third follow-up → blocked
- "stop" → muted, no further sends
- Claim without source URL → rejected from dossier

Run before every phase handoff: `bun test && bunx tsc --noEmit`

## Demo script (90 s)

1. Judge texts the line: "pester AcmeLumber". Lorax researches live, replies in character.
2. Show action kit with sources.
3. Teammate's phone (the "villain CEO") gets a prank nudge. Reply triggers a witty comeback.
4. Show terminal logs: tool calls, guardrail blocks.
5. Close: sustainability angle + how it was built with Cursor/Claude Code.

## Track mapping

- **Sustainability:** turns awareness into sourced, ready-to-send action
- **Photon:** iMessage-native agent, inbound-first, typing indicators, scheduled nudges
- **Cursor:** built phase by phase from this file (Cursor also reads `AGENTS.md`; copy this file there)
