import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Text,
} from "@react-email/components";

type LeadMagnetDeliveryProps = {
  downloadUrl: string;
  resourceTitle: string;
  firstName?: string;
  productName: string;
};

export default function LeadMagnetDelivery(props: Record<string, unknown>) {
  const { downloadUrl, resourceTitle, firstName, productName } = props as LeadMagnetDeliveryProps;

  return (
    <Html lang="en">
      <Head />
      <Preview>Your download is ready: {resourceTitle}</Preview>
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
          <Heading style={{ fontSize: "24px", color: "#111827", marginBottom: "16px" }}>
            Your resource is ready to download
          </Heading>
          <Text style={{ fontSize: "16px", color: "#374151", lineHeight: "1.6" }}>
            {firstName ? `Hi ${firstName},` : "Hi,"} thank you for your interest in {productName}!
            Your requested resource is ready:
          </Text>
          <Container
            style={{
              backgroundColor: "#f3f4f6",
              borderRadius: "6px",
              padding: "20px",
              margin: "16px 0",
            }}
          >
            <Text style={{ fontSize: "18px", color: "#111827", fontWeight: "600", margin: "0" }}>
              {resourceTitle}
            </Text>
          </Container>
          <Button
            href={downloadUrl}
            style={{
              backgroundColor: "#059669",
              color: "#ffffff",
              padding: "12px 24px",
              borderRadius: "6px",
              fontSize: "16px",
              fontWeight: "600",
              display: "inline-block",
              marginTop: "16px",
              marginBottom: "24px",
            }}
          >
            Download Now
          </Button>
          <Hr style={{ borderColor: "#e5e7eb", margin: "24px 0" }} />
          <Text style={{ fontSize: "14px", color: "#6b7280" }}>
            This download link is for your personal use. If you have any trouble accessing the file,
            reply to this email and we&apos;ll help you out.
          </Text>
          <Text style={{ fontSize: "14px", color: "#6b7280" }}>— The {productName} Team</Text>
        </Container>
      </Body>
    </Html>
  );
}
