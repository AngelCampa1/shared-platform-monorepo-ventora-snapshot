export type {
  EmailSendParams,
  EmailSendResult,
  EmailClient,
  EmailClientConfig,
} from "./client.js";
export { createEmailClient } from "./client.js";

export type { UnsubscribeCategory } from "./tokens.js";
export { generateUnsubscribeToken, verifyUnsubscribeToken } from "./tokens.js";

export type { CanSpamConfig } from "./canspam.js";
export { assertCanSpamCompliance, buildListUnsubscribeHeaders } from "./canspam.js";
