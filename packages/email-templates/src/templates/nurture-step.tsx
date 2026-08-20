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

type NurtureStepProps = {
  subject: string;
  body: string;
  ctaUrl?: string;
  ctaText?: string;
  productName: string;
};

export default function NurtureStep(props: Record<string, unknown>) {
  const { subject, body, ctaUrl, ctaText, productName } = props as NurtureStepProps;

  return (
    <Html lang="en">
      <Head />
      <Preview>{subject}</Preview>
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
            {subject}
          </Heading>
          <Text
            style={{
              fontSize: "16px",
              color: "#374151",
              lineHeight: "1.6",
              whiteSpace: "pre-wrap",
            }}
          >
            {body}
          </Text>
          {ctaUrl !== undefined && ctaUrl !== "" && (
            <Button
              href={ctaUrl}
              style={{
                backgroundColor: "#4f46e5",
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
              {ctaText ?? "Learn More"}
            </Button>
          )}
          <Hr style={{ borderColor: "#e5e7eb", margin: "24px 0" }} />
          <Text style={{ fontSize: "14px", color: "#6b7280" }}>— The {productName} Team</Text>
        </Container>
      </Body>
    </Html>
  );
}
