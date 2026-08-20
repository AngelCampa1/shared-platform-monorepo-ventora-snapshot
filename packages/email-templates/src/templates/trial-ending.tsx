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

type TrialEndingProps = {
  daysLeft: number;
  upgradeUrl: string;
  firstName?: string;
  productName: string;
};

export default function TrialEnding(props: Record<string, unknown>) {
  const { daysLeft, upgradeUrl, firstName, productName } = props as TrialEndingProps;

  return (
    <Html lang="en">
      <Head />
      <Preview>{`Your ${productName} trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"} — upgrade to keep access.`}</Preview>
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
            Your trial ends in {daysLeft} day{daysLeft === 1 ? "" : "s"}
          </Heading>
          <Text style={{ fontSize: "16px", color: "#374151", lineHeight: "1.6" }}>
            {firstName ? `Hi ${firstName},` : "Hi,"} your free trial of {productName} is ending
            soon. You have {daysLeft} day{daysLeft === 1 ? "" : "s"} left to upgrade and keep access
            to all your data and features.
          </Text>
          <Text style={{ fontSize: "16px", color: "#374151", lineHeight: "1.6" }}>
            Upgrade now to continue without interruption. Your data is safe and will carry over
            seamlessly.
          </Text>
          <Button
            href={upgradeUrl}
            style={{
              backgroundColor: "#f59e0b",
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
            Upgrade Now
          </Button>
          <Hr style={{ borderColor: "#e5e7eb", margin: "24px 0" }} />
          <Text style={{ fontSize: "14px", color: "#6b7280" }}>
            Questions about pricing? Reply to this email and we&apos;ll help you find the right plan
            for your needs.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
