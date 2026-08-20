export type CanSpamConfig = {
  postalAddress: string;
  unsubscribeUrl?: string;
};

export function assertCanSpamCompliance(config: CanSpamConfig): void {
  if (!config.postalAddress || config.postalAddress.trim() === "") {
    throw new Error(
      "CAN-SPAM compliance requires a physical postal address. Set postalAddress in EmailClientConfig.",
    );
  }
  const lower = config.postalAddress.toLowerCase();
  if (
    (lower.includes("[") && lower.includes("]")) ||
    lower.includes("placeholder") ||
    lower.includes("todo")
  ) {
    throw new Error(
      `CAN-SPAM postalAddress looks like a placeholder: "${config.postalAddress}". Set a real address.`,
    );
  }
}

export function buildListUnsubscribeHeaders(unsubscribeUrl: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
