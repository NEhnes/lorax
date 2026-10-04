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

export async function runAgent(senderId: string | undefined, text: string) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");

  const messages: any[] = [
    { role: "system", content: LORAX_PERSONA },
    { role: "user", content: text },
  ];

  while (true) {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, tools, max_tokens: 1000 }),
    });
    if (!response.ok) {
      throw new Error(`OpenRouter request failed (${response.status}): ${await response.text()}`);
    }

    const res: any = await response.json();
    const message = res.choices?.[0]?.message;
    if (!message) return "";
    messages.push(message);

    const toolCalls = extractToolCalls(message.tool_calls || []);
    if (toolCalls.length === 0) return message.content ?? "";

    const results = await Promise.all(
      toolCalls.map((toolCall: any) => runToolCall(toolCall.name, toolCall.arguments || {})),
    );
    for (let i = 0; i < toolCalls.length; i++) {
      messages.push({
        role: "tool",
        tool_call_id: toolCalls[i].id,
        content: JSON.stringify(results[i]),
      });
    }
  }
}
