import { LORAX_PERSONA } from "./persona";
import { canSendPrank, validateOpenerText } from "./guardrails";
import { createNudge, dueNudges, logSend, rescheduleNudge, setNudgeStatus, type Nudge } from "./store";

const baseUrl = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const model = process.env.OPENROUTER_MODEL || "xiaomi/mimo-v2.5";

/** How often the scheduler looks for due nudges. */
export const POLL_INTERVAL_MS = 30_000;

const FRIEND_PROMPT =
  "You are texting a friend who has agreed to a bit of harmless banter. Write ONE short text-only message: no links, no URLs, no phone numbers, no addresses, under 300 characters, in your witty mildly sarcastic Lorax voice, and it must end with a question. Sarcastic, never cruel, never about appearance, family, or identity. Output only the message text.";

/** Generate prank copy. Kept text-only so the opener guardrail can verify it. */
export async function generatePrankText(intent: string) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: `${LORAX_PERSONA}\n\n${FRIEND_PROMPT}` },
        { role: "user", content: intent },
      ],
      max_tokens: 120,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter request failed (${response.status}): ${await response.text()}`);
  }
  const res: any = await response.json();
  const text = res.choices?.[0]?.message?.content ?? "";
  // Models often wrap output in quotes; strip them so the text guardrail sees
  // the actual message.
  return text.trim().replace(/^["“](.*)["”]$/s, "$1").trim();
}

export type PrankResult = { nudgeId: number; phone: string; outcome: string; body?: string };

/**
 * Run one nudge through the guardrails and, only if it clears them, send it.
 * Deferred nudges (quiet hours, spacing) are pushed back rather than dropped.
 */
export async function processNudge(
  nudge: Nudge,
  send: (phone: string, text: string) => Promise<void>,
  at: number = Date.now(),
  dryRun = process.env.PRANK_DRY_RUN !== "false",
): Promise<PrankResult> {
  const kind = nudge.kind === "opener" ? "prank_opener" : "prank_followup";

  const decision = canSendPrank(nudge.phone, kind, at);
  if (!decision.ok) {
    if (decision.retryAt && decision.retryAt > at) {
      rescheduleNudge(nudge.id, decision.retryAt);
      logSend({ phone: nudge.phone, kind, status: "deferred", detail: decision.reason, createdAt: at });
      return { nudgeId: nudge.id, phone: nudge.phone, outcome: `deferred: ${decision.reason}` };
    }
    setNudgeStatus(nudge.id, "blocked");
    logSend({ phone: nudge.phone, kind, status: "blocked", detail: decision.reason, createdAt: at });
    return { nudgeId: nudge.id, phone: nudge.phone, outcome: `blocked: ${decision.reason}` };
  }

  let body: string;
  try {
    body = await generatePrankText(nudge.intent);
  } catch (e: any) {
    setNudgeStatus(nudge.id, "pending");
    return { nudgeId: nudge.id, phone: nudge.phone, outcome: `generation failed: ${String(e)}` };
  }

  // Openers have extra copy rules. Follow-ups are already continuations of a
  // live conversation, so only the send caps apply to them.
  if (kind === "prank_opener") {
    const textCheck = validateOpenerText(body);
    if (!textCheck.ok) {
      setNudgeStatus(nudge.id, "blocked");
      logSend({
        phone: nudge.phone,
        kind,
        status: "blocked",
        detail: `opener text: ${textCheck.reason}`,
        body,
        createdAt: at,
      });
      return { nudgeId: nudge.id, phone: nudge.phone, outcome: `blocked: opener text: ${textCheck.reason}` };
    }
  }

  if (dryRun) {
    setNudgeStatus(nudge.id, "sent", at);
    logSend({ phone: nudge.phone, kind, status: "dry_run", body, createdAt: at });
    console.log(`[prank dry-run] would text ${nudge.phone}: ${body}`);
    return { nudgeId: nudge.id, phone: nudge.phone, outcome: "dry-run", body };
  }

  try {
    await send(nudge.phone, body);
    setNudgeStatus(nudge.id, "sent", at);
    logSend({ phone: nudge.phone, kind, status: "sent", body, createdAt: at });
    return { nudgeId: nudge.id, phone: nudge.phone, outcome: "sent", body };
  } catch (e: any) {
    setNudgeStatus(nudge.id, "pending");
    logSend({ phone: nudge.phone, kind, status: "blocked", detail: `send failed: ${String(e)}`, createdAt: at });
    return { nudgeId: nudge.id, phone: nudge.phone, outcome: `send failed: ${String(e)}` };
  }
}

export async function drainDueNudges(
  send: (phone: string, text: string) => Promise<void>,
  at: number = Date.now(),
  dryRun = process.env.PRANK_DRY_RUN !== "false",
) {
  const results: PrankResult[] = [];
  for (const nudge of dueNudges(at)) {
    results.push(await processNudge(nudge, send, at, dryRun));
  }
  return results;
}

/**
 * Long-lived loop. Started by index.ts; the process stays alive because of it.
 */
export function startPrankScheduler(
  send: (phone: string, text: string) => Promise<void>,
  intervalMs = POLL_INTERVAL_MS,
) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const results = await drainDueNudges(send);
      for (const r of results) {
        if (r.outcome !== "sent") console.log(`[prank] nudge ${r.nudgeId} -> ${r.outcome}`);
      }
    } catch (e: any) {
      console.error(`[prank] scheduler error: ${String(e)}`);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

export { createNudge };
