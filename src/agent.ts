import { LORAX_PERSONA } from "./persona";
import { extractToolCalls, runToolCall } from "./tools";

const baseUrl = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const model = process.env.OPENROUTER_MODEL || "xiaomi/mimo-v2.5";
const tools = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for sourced information.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_dossier",
      description: "Save sourced claims about a company.",
      parameters: {
        type: "object",
        properties: {
          company: { type: "string" },
          claims: {
            type: "array",
            items: {
              type: "object",
              properties: { text: { type: "string" }, source_url: { type: "string" } },
              required: ["text", "source_url"],
              additionalProperties: false,
            },
          },
        },
        required: ["company", "claims"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mute",
      description: "Permanently stop all contact with a number. Use when someone asks to stop.",
      parameters: {
        type: "object",
        properties: { phone: { type: "string" } },
        required: ["phone"],
        additionalProperties: false,
      },
    },
  },
];

export function validateContactPage(content: string, searchResults: Array<{ title: string; snippet: string; url: string }>) {
  let contactFound = false;
  const lines = content.split("\n");
  const output: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*(?:public\s+)?contact(?:[-\s]+page)?(?:\s+URL)?\s*:/i.test(line)) {
      output.push(line);
      continue;
    }
    const urls = line.match(/https?:\/\/[^\s<>()]+/g) || [];
    const nextLineUrls = urls.length === 0
      ? lines[i + 1]?.match(/https?:\/\/[^\s<>()]+/g) || []
      : [];
    const allUrls = [...urls, ...nextLineUrls];
    const supportedUrls = allUrls.filter((url) => {
      const normalizedUrl = url.replace(/[.,;!?]+$/, "");
      return searchResults.some((result) =>
        result.url === normalizedUrl && /contact/i.test(`${result.title} ${result.snippet}`),
      );
    });
    contactFound = true;
    if (allUrls.length !== 1 || supportedUrls.length !== 1) {
      output.push("Public contact page: not found.");
      if (nextLineUrls.length > 0) i++;
      continue;
    }
    output.push(line);
    if (nextLineUrls.length > 0) output.push(lines[++i]);
  }
  if (!contactFound) output.push("Public contact page: not found.");
  return output.join("\n");
}

export async function runAgent(senderId: string | undefined, text: string) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");

  const isPester = /^\s*pester\b/i.test(text);
  const systemPrompt = isPester
    ? `${LORAX_PERSONA}\n\nFor a user request in the form "pester <company>", prepare an action kit for that company. Research with web_search and return exactly three factual claims, each with its own source URL from an actual search result. Save those three claims with save_dossier. Also draft an email and a social post in your witty, mildly sarcastic Lorax voice; keep them factual, respectful, and non-abusive. Clearly label both messages as drafts for the human to send. Never send messages to the company.\n\nSearch for the company's public contact page with web_search. Then, on its own final line, output the contact page in exactly this canonical format:\n\nPublic contact page: <url>\n\nUse that format only if a search result actually supports that the URL is the company's contact page. Otherwise output exactly:\n\nPublic contact page: not found.\n\nNever present a generic search URL as the contact page. The canonical line must contain exactly one URL (or the literal "not found.").`
    : `${LORAX_PERSONA}\n\nAnswer the user's question directly in character, using web_search when you need sourced facts. Do NOT output any "Public contact page:" line — that line is reserved for action-kit ("pester <company>") requests.`;
  const messages: any[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: text },
  ];
  const searchResults = new Set<string>();
  const searchedResults: Array<{ title: string; snippet: string; url: string }> = [];
  let rounds = 0;
  let saveNudged = false;

  while (true) {
    if (++rounds > 8) {
      return "The request needed too many research steps and was stopped. Please retry with a narrower request.";
    }
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, tools, max_tokens: 4096 }),
    });
    if (!response.ok) {
      throw new Error(`OpenRouter request failed (${response.status}): ${await response.text()}`);
    }

    const res: any = await response.json();
    const message = res.choices?.[0]?.message;
    if (!message) return "";
    messages.push(message);

    const toolCalls = extractToolCalls(message.tool_calls || []);
    if (res.choices?.[0]?.finish_reason === "length") {
      return "The action kit exceeded the 4096-token response limit and was cut off. Please retry with a narrower request.";
    }

    if (toolCalls.length === 0) {
      const content = message.content ?? "";
      if (isPester) return validateContactPage(content, searchedResults);
      // Ordinary conversational replies should not carry a contact-page line; strip any
      // stray one (and a following URL-only line) in case the model emits it anyway.
      const kept: string[] = [];
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*(?:public\s+)?contact(?:[-\s]+page)?(?:\s+URL)?\s*:/i.test(lines[i])) {
          if (!/https?:\/\//i.test(lines[i]) && /^\s*https?:\/\//i.test(lines[i + 1] ?? "")) i++;
          continue;
        }
        kept.push(lines[i]);
      }
      return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    }

    const results = await Promise.all(
      toolCalls.map((toolCall: any) => runToolCall(toolCall.name, toolCall.arguments || {}, searchResults)),
    );
    for (let i = 0; i < toolCalls.length; i++) {
      const result = results[i];
      if (toolCalls[i].name === "web_search" && Array.isArray(result?.results)) {
        for (const searchResult of result.results) searchedResults.push(searchResult);
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCalls[i].id,
        content: JSON.stringify(result),
      });
    }

    // Demo step 3: a research reply about a company should persist its sourced claims
    // to the local dossier. Prompt the model once after it has searched, if it hasn't saved.
    const savedDossier = toolCalls.some((toolCall: any) => toolCall.name === "save_dossier");
    if (!isPester && !savedDossier && !saveNudged && searchResults.size > 0) {
      saveNudged = true;
      messages.push({
        role: "system",
        content: "Save the sourced claims you found to the company's local dossier with save_dossier before answering.",
      });
    }
  }
}
