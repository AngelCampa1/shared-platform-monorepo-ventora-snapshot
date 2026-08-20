import { Body, Container, Head, Heading, Hr, Html, Preview, Text } from "@react-email/components";

type InternalErrorFallbackProps = {
  trackingId?: string;
  supportEmail: string;
};

export default function InternalErrorFallback(props: Record<string, unknown>) {
  const { trackingId, supportEmail } = props as InternalErrorFallbackProps;

  return (
    <Html lang="en">
      <Head />
      <Preview>We encountered an issue — our team has been notified.</Preview>
      <Body
        style={{ fontFamily: "sans-serif", backgroundColor: "#f9fafb", margin: "0", padding: "0" }}
      >
        <Container
          style={{
            maxWidth: "600px",
            margin: "40px auto",
            backgroundColor: "#ffffff",
            borderRadius: "8px",
            padding: "40px",
          }}
        >
          <Heading style={{ fontSize: "24px", color: "#dc2626", marginBottom: "16px" }}>
            Something went wrong
          </Heading>
          <Text style={{ fontSize: "16px", color: "#374151", lineHeight: "1.6" }}>
            We encountered an unexpected error while processing your request. Our team has been
            automatically notified and is investigating the issue.
          </Text>
          {trackingId !== undefined && trackingId !== "" && (
            <Text style={{ fontSize: "14px", color: "#6b7280", fontFamily: "monospace" }}>
              Tracking ID: {trackingId}
            </Text>
          )}
          <Text style={{ fontSize: "16px", color: "#374151", lineHeight: "1.6" }}>
            If you need immediate assistance, please contact our support team and include the
            tracking ID above (if provided) in your message.
          </Text>
          <Hr style={{ borderColor: "#e5e7eb", margin: "24px 0" }} />
          <Text style={{ fontSize: "14px", color: "#6b7280" }}>Support: {supportEmail}</Text>
          <Text style={{ fontSize: "14px", color: "#6b7280" }}>
            We apologize for the inconvenience and will resolve this as quickly as possible.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
