import Anthropic from "@anthropic-ai/sdk";
import { LORAX_PERSONA } from "./persona";
import { extractToolCalls, runToolCall } from "./tools";

const client = new Anthropic();
const model = process.env.ANTHROPIC_MODEL!;

export async function runAgent(senderId: string | undefined, text: string) {
  let messages: any[] = [{ role: "user", content: text }];

  while (true) {
    const res: any = await client.messages.create({ model, system: LORAX_PERSONA, messages, max_tokens: 1000 });
    messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason !== "tool_use") {
      const textBlock = res.content.find((b: any) => b.type === "text");
      return textBlock?.text ?? "";
    }

    const toolCalls = extractToolCalls(res.content);
    if (toolCalls.length === 0) {
      const textBlock = res.content.find((b: any) => b.type === "text");
      return textBlock?.text ?? "";
    }

    const results = await Promise.all(toolCalls.map((tc: any) => runToolCall(tc.name, tc.arguments || {})));
    messages.push({ role: "user", content: results });
  }
}
