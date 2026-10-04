import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { runAgent } from "./agent";
import { canReply, isStopRequest } from "./guardrails";
import { splitMessage } from "./message";
import { isMuted, logSend, mute, touchUser } from "./store";

const app = await Spectrum({
  projectId: process.env.SPECTRUM_PROJECT_ID!,
  projectSecret: process.env.SPECTRUM_PROJECT_SECRET!,
  providers: [imessage.config()],
});

const dryRun = process.env.DRY_RUN !== "false";

console.log(`Lorax Hotline ready on iMessage. Dry run: ${dryRun}`);

const im = imessage(app);

/** Outbound for prank mode. Guardrails already cleared this send. */
async function sendToFriend(phone: string, text: string) {
  const friend = await im.user(phone);
  const dm = await im.space.create(friend);
  for (const chunk of splitMessage(text)) await dm.send(chunk);
}

const testTo = process.env.TEST_TO;
if (process.env.SEND_TEST_MESSAGE === "true" && testTo) {
  const recipient = await im.user(testTo);
  const dm = await im.space.create(recipient);
  await dm.send("Test message from Lorax.");
  console.log(`Sent test iMessage to ${testTo}`);
}

for await (const [space, message] of app.messages) {
  if (message.platform !== "imessage" || message.content.type !== "text") continue;

  const sender = message.sender?.id;
  const text = message.content.text;

  // STOP wins over everything, including a pending reply.
  if (isStopRequest(text)) {
    if (sender) {
      mute(sender, "asked to stop");
      console.log(`Muted ${sender} permanently.`);
    }
    if (!dryRun) {
      for (const chunk of splitMessage("Understood. I will not contact you again.")) await space.send(chunk);
    }
    continue;
  }

  if (isMuted(sender)) {
    console.log(`Ignoring message from muted ${sender ?? "unknown"}.`);
    continue;
  }

  if (sender) touchUser(sender);

  const reply = await runAgent(sender, text);
  if (!reply) continue;

  const decision = canReply(sender);
  if (!decision.ok) {
    console.log(`Reply blocked for ${sender ?? "unknown"}: ${decision.reason}`);
    if (sender) logSend({ phone: sender, kind: "reply", status: "blocked", detail: decision.reason });
    continue;
  }

  if (dryRun) {
    console.log(`Dry-run reply to ${sender ?? "unknown sender"}: ${reply}`);
    if (sender) logSend({ phone: sender, kind: "reply", status: "dry_run", body: reply });
    continue;
  }

  for (const chunk of splitMessage(reply)) await space.send(chunk);
  if (sender) logSend({ phone: sender, kind: "reply", status: "sent", body: reply });
}
