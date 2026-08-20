import type { Resend } from "resend";
import { assertCanSpamCompliance } from "./canspam.js";
import { buildListUnsubscribeHeaders } from "./canspam.js";

export type EmailSendParams = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  from?: string;
  headers?: Record<string, string>;
  tags?: { name: string; value: string }[];
  idempotencyKey?: string;
  unsubscribeUrl?: string;
};

export type EmailSendResult = { id: string };

export interface EmailClient {
  send(params: EmailSendParams): Promise<EmailSendResult>;
  sendIdempotent(
    params: EmailSendParams & { entityId: string; operationType: string },
  ): Promise<EmailSendResult>;
}

export type EmailClientConfig = {
  resendApiKey: string;
  defaultFrom: string;
  postalAddress: string;
};

export function createEmailClient(config: EmailClientConfig): EmailClient {
  assertCanSpamCompliance({ postalAddress: config.postalAddress });

  let resendInstance: Resend | undefined;
  async function getResend(): Promise<Resend> {
    if (resendInstance === undefined) {
      const { Resend } = await import("resend");
      resendInstance = new Resend(config.resendApiKey);
    }
    return resendInstance;
  }

  async function send(params: EmailSendParams): Promise<EmailSendResult> {
    const resend = await getResend();
    const extraHeaders: Record<string, string> = {};

    if (params.unsubscribeUrl) {
      const unsubHeaders = buildListUnsubscribeHeaders(params.unsubscribeUrl);
      Object.assign(extraHeaders, unsubHeaders);
    }

    const mergedHeaders = {
      ...params.headers,
      ...extraHeaders,
    };

    const sendParams: Parameters<typeof resend.emails.send>[0] = {
      from: params.from ?? config.defaultFrom,
      to: params.to,
      subject: params.subject,
      html: params.html,
      ...(params.text !== undefined ? { text: params.text } : {}),
      ...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
      ...(Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : {}),
      ...(params.tags !== undefined ? { tags: params.tags } : {}),
    };

    const options =
      params.idempotencyKey !== undefined ? { idempotencyKey: params.idempotencyKey } : undefined;

    const { data, error } = options
      ? await resend.emails.send(sendParams, options)
      : await resend.emails.send(sendParams);

    if (error !== null && error !== undefined) {
      throw new Error(`Resend error: ${error.message}`);
    }

    if (data === null || data === undefined) {
      throw new Error("Resend returned no data and no error");
    }

    return { id: data.id };
  }

  async function sendIdempotent(
    params: EmailSendParams & { entityId: string; operationType: string },
  ): Promise<EmailSendResult> {
    const idempotencyKey = `${params.entityId}:${params.operationType}`;
    const { entityId: _entityId, operationType: _operationType, ...rest } = params;
    return send({ ...rest, idempotencyKey });
  }

  return { send, sendIdempotent };
}
