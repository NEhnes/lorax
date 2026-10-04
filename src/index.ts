import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { runAgent } from "./agent";

const app = await Spectrum({
  projectId: process.env.SPECTRUM_PROJECT_ID!,
  projectSecret: process.env.SPECTRUM_PROJECT_SECRET!,
  providers: [imessage.config()],
});

const dryRun = process.env.DRY_RUN !== "false";

console.log(`Lorax Hotline ready on iMessage. Dry run: ${dryRun}`);

const testTo = process.env.TEST_TO;
if (process.env.SEND_TEST_MESSAGE === "true" && testTo) {
  const im = imessage(app);
  const recipient = await im.user(testTo);
  const dm = await im.space.create(recipient);
  await dm.send("Test message from Lorax.");
  console.log(`Sent test iMessage to ${testTo}`);
}

for await (const [space, message] of app.messages) {
  if (message.platform !== "imessage" || message.content.type !== "text") continue;

  const reply = await runAgent(message.sender?.id, message.content.text);
  const replyText = reply.slice(0, 299).replace(/[\uD800-\uDBFF]$/, "");
  if (dryRun) {
    console.log(`Dry-run reply to ${message.sender?.id ?? "unknown sender"}: ${replyText}`);
    continue;
  }

  await space.send(replyText);
}
