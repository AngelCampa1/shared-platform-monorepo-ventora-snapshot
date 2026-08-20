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

type TrialExpiredProps = {
  upgradeUrl: string;
  firstName?: string;
  productName: string;
};

export default function TrialExpired(props: Record<string, unknown>) {
  const { upgradeUrl, firstName, productName } = props as TrialExpiredProps;

  return (
    <Html lang="en">
      <Head />
      <Preview>Your {productName} trial has ended — reactivate your account today.</Preview>
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
            Your {productName} trial has ended
          </Heading>
          <Text style={{ fontSize: "16px", color: "#374151", lineHeight: "1.6" }}>
            {firstName ? `Hi ${firstName},` : "Hi,"} your free trial of {productName} has expired.
            Your account has been paused, but your data is safe.
          </Text>
          <Text style={{ fontSize: "16px", color: "#374151", lineHeight: "1.6" }}>
            Upgrade to a paid plan to reactivate your account and continue where you left off. All
            your data and settings are preserved and waiting for you.
          </Text>
          <Button
            href={upgradeUrl}
            style={{
              backgroundColor: "#dc2626",
              color: "#ffffff",
              padding: "12px 24px",
              borderRadius: "6px",
              fontSize: "16px",
              fontWeight: "600",
              display: "inline-block",
              marginTop: "8px",
              marginBottom: "24px",
            }}
          >
            Reactivate Account
          </Button>
          <Hr style={{ borderColor: "#e5e7eb", margin: "24px 0" }} />
          <Text style={{ fontSize: "14px", color: "#6b7280" }}>
            Need help choosing a plan? Reply to this email and our team will assist you.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
