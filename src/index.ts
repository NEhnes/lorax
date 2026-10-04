import { Spectrum } from "spectrum-ts";
import { terminal } from "spectrum-ts/providers/terminal";

const app = await Spectrum({
  providers: [terminal.config()],
});

console.log("Lorax Hotline terminal echo ready. Type a message to see it echoed.");

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") continue;
  await space.send(`Echo: ${message.content.text}`);
}
