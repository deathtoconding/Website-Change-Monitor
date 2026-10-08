import { randomUUID } from "node:crypto";
import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;
const sender = process.env.EMAIL_FROM;
const recipient = process.env.EMAIL_TEST_RECIPIENT;

if (!apiKey?.startsWith("re_"))
  throw new Error("Resend qualification requires a valid-looking re_ API key.");
if (!sender || !recipient)
  throw new Error(
    "Resend qualification requires EMAIL_FROM and an explicitly controlled EMAIL_TEST_RECIPIENT.",
  );

const qualificationId =
  process.env.QUALIFICATION_RUN_ID ?? randomUUID().replaceAll("-", "");
const resend = new Resend(apiKey);
const result = await resend.emails.send(
  {
    from: sender,
    to: recipient,
    subject: `Watchtower CI provider qualification ${qualificationId}`,
    text: `This is a one-message Resend API acceptance check for CI run ${qualificationId}. No action is required.`,
    html: `<p>This is a one-message Resend API acceptance check for CI run <code>${qualificationId}</code>.</p><p>No action is required.</p>`,
  },
  { idempotencyKey: `wcm-email-qualification-${qualificationId}` },
);

if (result.error || !result.data?.id) {
  const providerMessage =
    result.error?.message ?? "Resend returned no message ID.";
  throw new Error(
    `Resend did not accept the controlled-recipient message: ${providerMessage}`,
  );
}

console.log(
  `Resend accepted one qualification email for the configured controlled recipient (message ${result.data.id}). Delivery to the inbox was not independently verified.`,
);
