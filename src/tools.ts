import { saveDossier, getDossier } from "./dossiers.js";
import { canSendPrank, isQuietHour } from "./guardrails.js";
import { createNudge, isFriend, mute as mutePhone } from "./store.js";

export function extractToolCalls(toolCalls: any[]) {
  return toolCalls.map((call) => ({
    id: call.id,
    name: call.function.name,
    arguments: JSON.parse(call.function.arguments || "{}"),
  }));
}

export function validateClaims(claims: any[], searchResults: Set<string>) {
  if (!Array.isArray(claims)) return "claims must be an array";
  if (claims.length !== 3) return "exactly three claims are required";
  for (const c of claims) {
    if (!c || typeof c.text !== "string") return "each claim must have a text field";
    if (!c.text.trim()) return "each claim must have non-empty text";
    if (!c.source_url || typeof c.source_url !== "string") return "each claim must have a source_url";
    if (!/^https?:\/\//.test(c.source_url)) return "source_url must be an http(s) url";
    if (!searchResults.has(c.source_url)) {
      return `source_url must match a URL returned by web_search: ${c.source_url}`;
    }
  }
  return null;
}

export async function runToolCall(name: string, args: any, searchResults = new Set<string>()) {
  if (name === "web_search") {
    const q = (args && (args.query || args.q || args.term)) || args;
    if (!q || typeof q !== "string") return { tool: name, error: "missing query string" };

    // Use DuckDuckGo Instant Answer API as a simple, dependency-free search backend.
    // It provides titles/snippets and URLs for many queries. Not a full web index, but good for demo.
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) return { tool: name, error: `search failed: ${resp.status}` };
      const data = await resp.json();
      const results: any[] = [];

      // Results can appear in Results or RelatedTopics
      if (Array.isArray(data.Results)) {
        for (const r of data.Results) {
          if (r.FirstURL) results.push({ title: r.Text || r.Result || "", url: r.FirstURL, snippet: r.Text || "" });
        }
      }
      if (Array.isArray(data.RelatedTopics)) {
        for (const t of data.RelatedTopics) {
          if (t.FirstURL) results.push({ title: t.Text || "", url: t.FirstURL, snippet: t.Text || "" });
          else if (t.Topics) {
            for (const s of t.Topics) {
              if (s.FirstURL) results.push({ title: s.Text || "", url: s.FirstURL, snippet: s.Text || "" });
            }
          }
        }
      }

      // Deduplicate by URL and return top 5
      const seen = new Set();
      const out = [];
      for (const r of results) {
        if (!r.url) continue;
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        out.push(r);
        if (out.length >= 5) break;
      }

      for (const result of out) searchResults.add(result.url);
      return { tool: name, query: q, results: out };
    } catch (e: any) {
      return { tool: name, error: `search error: ${String(e)}` };
    }
  }

  if (name === "save_dossier") {
    const company = args && args.company;
    const claims = args && args.claims;
    if (!company || typeof company !== "string") return { tool: name, error: "missing company" };

    const err = validateClaims(claims, searchResults);
    if (err) return { tool: name, error: `invalid claims: ${err}` };

    try {
      const id = await saveDossier(company, claims);
      const dossier = await getDossier(id);
      return { tool: name, dossier };
    } catch (e: any) {
      return { tool: name, error: String(e) };
    }
  }

  if (name === "schedule_nudge") {
    const phone = args && args.phone;
    const intent = args && args.intent;
    const delayMin = Number(args?.delay_min ?? 0);
    if (!phone || typeof phone !== "string") return { tool: name, error: "missing phone" };
    if (!intent || typeof intent !== "string") return { tool: name, error: "missing intent" };
    if (!isFriend(phone)) return { tool: name, error: "not on the friends allowlist" };

    const kind = delayMin > 0 ? "followup" : "opener";
    const decision = canSendPrank(phone, kind === "opener" ? "prank_opener" : "prank_followup");
    if (!decision.ok && !decision.retryAt) {
      return { tool: name, error: `guardrail blocked this nudge: ${decision.reason}` };
    }

    // Quiet hours or spacing defer rather than refuse: schedule for the first
    // legal moment instead.
    const at = decision.ok ? Date.now() : (decision.retryAt ?? Date.now());
    const nudge = createNudge({
      phone,
      kind,
      intent,
      sendAt: at + (Number.isFinite(delayMin) ? delayMin : 0) * 60_000,
    });
    return {
      tool: name,
      nudge_id: nudge.id,
      phone: nudge.phone,
      kind: nudge.kind,
      send_at: new Date(nudge.send_at).toISOString(),
      note: decision.ok ? undefined : `deferred until ${new Date(nudge.send_at).toISOString()}: ${decision.reason}`,
      quiet_hours: isQuietHour(nudge.send_at),
    };
  }

  if (name === "mute") {
    const phone = args && args.phone;
    if (!phone || typeof phone !== "string") return { tool: name, error: "missing phone" };
    return { tool: name, phone: mutePhone(phone, "requested by recipient"), muted: true };
  }

  // Unknown tool
  return { tool: name, result: `Tool ${name} not implemented` };
}
