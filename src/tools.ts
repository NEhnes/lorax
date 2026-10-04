import { saveDossier, getDossier } from "./dossiers.js";
import { mute as mutePhone } from "./store.js";

const baseUrl = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const searchModel = process.env.OPENROUTER_SEARCH_MODEL || process.env.OPENROUTER_MODEL || "xiaomi/mimo-v2.5";

function normalizeResult(raw: any) {
  const citation = raw?.url_citation ?? raw;
  const url = citation?.url;
  if (!url || typeof url !== "string") return null;
  return {
    title: String(citation?.title || url),
    snippet: String(citation?.content || citation?.snippet || citation?.title || ""),
    url,
  };
}

async function searchViaOpenRouter(q: string, apiKey: string) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: searchModel,
      messages: [{
        role: "user",
        content: `Search the web for: ${q}\n\nList the most relevant sources with their exact URLs.`,
      }],
      plugins: [{ id: "web" }],
      max_tokens: 1024,
    }),
  });
  if (!response.ok) throw new Error(`search failed: ${response.status}`);
  const data: any = await response.json();
  const annotations = data?.choices?.[0]?.message?.annotations;
  if (!Array.isArray(annotations)) return [];
  return annotations
    .filter((a: any) => a?.type === "url_citation")
    .map(normalizeResult)
    .filter((r: any) => r !== null);
}

async function searchViaWikipedia(q: string) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=5&prop=extracts|info&inprop=url&exintro=1&explaintext=1&format=json&origin=*`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`search failed: ${response.status}`);
  const data: any = await response.json();
  const pages = data?.query?.pages;
  if (!pages || typeof pages !== "object") return [];
  return Object.values(pages).map((page: any) => ({
    title: String(page?.title || ""),
    snippet: String(page?.extract || "").slice(0, 300),
    url: page?.fullurl,
  })).filter((r: any) => r.url);
}

export function extractToolCalls(toolCalls: any[]) {
  return toolCalls.map((call) => {
    let args: any = {};
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      args = {};
    }
    return { id: call.id, name: call.function.name, arguments: args };
  });
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

    // Backed by OpenRouter's web plugin (same API key/base URL, no new dependency).
    // Falls back to the Wikipedia search API if OpenRouter returns no citations.
    const apiKey = process.env.OPENROUTER_API_KEY;
    try {
      let results: any[] = [];
      if (apiKey) {
        try {
          results = await searchViaOpenRouter(q, apiKey);
        } catch {
          results = [];
        }
      }
      if (results.length === 0) {
        results = await searchViaWikipedia(q);
      }

      // Deduplicate by URL and return top 5
      const seen = new Set();
      const out = [];
      for (const r of results) {
        if (!r?.url || seen.has(r.url)) continue;
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

    // Within a single run, save each company's dossier only once so a looping model
    // cannot spam duplicate files for the same company.
    const dossierKey = `dossier:${company.trim().toLowerCase().replace(/\s+/g, " ")}`;
    if (searchResults.has(dossierKey)) {
      return { tool: name, company, deduplicated: true, note: `a dossier for ${company} was already saved in this run` };
    }

    const err = validateClaims(claims, searchResults);
    if (err) return { tool: name, error: `invalid claims: ${err}` };

    try {
      const id = await saveDossier(company, claims);
      searchResults.add(dossierKey);
      const dossier = await getDossier(id);
      return { tool: name, dossier };
    } catch (e: any) {
      return { tool: name, error: String(e) };
    }
  }

  if (name === "mute") {
    const phone = args && args.phone;
    if (!phone || typeof phone !== "string") return { tool: name, error: "missing phone" };
    return { tool: name, phone: mutePhone(phone, "requested by recipient"), muted: true };
  }

  // Unknown tool
  return { tool: name, result: `Tool ${name} not implemented` };
}
