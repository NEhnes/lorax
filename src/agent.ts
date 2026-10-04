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

  const messages: any[] = [
    { role: "system", content: `${LORAX_PERSONA}\n\nFor a user request in the form "pester <company>", prepare an action kit for that company. Research with web_search and return exactly three factual claims, each with its own source URL from an actual search result. Save those three claims with save_dossier. Also draft an email and a social post in your witty, mildly sarcastic Lorax voice; keep them factual, respectful, and non-abusive. Include the company's public contact-page URL only if an actual search result supports that it is the company's contact page. If no result supports it, explicitly say the public contact page was not found; never present a generic search URL as the contact page. Clearly label both messages as drafts for the human to send. Never send messages to the company.` },
    { role: "user", content: text },
  ];
  const searchResults = new Set<string>();
  const searchedResults: Array<{ title: string; snippet: string; url: string }> = [];

  while (true) {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, tools, max_tokens: 250 }),
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
      return "The action kit exceeded the 250-token response limit and was cut off. Please retry with a narrower request.";
    }

    if (toolCalls.length === 0) {
      return validateContactPage(message.content ?? "", searchedResults);
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
  }
}
