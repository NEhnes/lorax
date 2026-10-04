import Anthropic from "@anthropic-ai/sdk";
import { Spectrum } from "spectrum-ts";
import { terminal } from "spectrum-ts/providers/terminal";
import { LORAX_PERSONA } from "./persona";

const client = new Anthropic();
const model = process.env.ANTHROPIC_MODEL!;

const app = await Spectrum({
  providers: [terminal.config()],
});

console.log("Lorax Hotline ready. Talk to the trees.");

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") continue;

  const response = await client.messages.create({
    model,
    system: LORAX_PERSONA,
    messages: [{ role: "user", content: message.content.text }],
    max_tokens: 150,
  });
  const reply = response.content.find((block) => block.type === "text");
  if (reply?.type === "text") {
    await space.send([...reply.text].slice(0, 299).join(""));
  }
}
