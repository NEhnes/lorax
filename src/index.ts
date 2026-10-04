import { Spectrum } from "spectrum-ts";
import { terminal } from "spectrum-ts/providers/terminal";
import { runAgent } from "./agent";

const app = await Spectrum({
  providers: [terminal.config()],
});

console.log("Lorax Hotline ready. Talk to the trees.");

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") continue;

  const replyText = await runAgent(message.sender?.id, message.content.text);
  await space.send(replyText.slice(0, 299));
}
