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

type WelcomeProps = {
  productName: string;
  firstName: string;
  loginUrl: string;
  trialDays?: number;
};

export default function Welcome(props: Record<string, unknown>) {
  const { productName, firstName, loginUrl, trialDays } = props as WelcomeProps;

  return (
    <Html lang="en">
      <Head />
      <Preview>Welcome to {productName}! Your account is ready.</Preview>
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
            Welcome to {productName}, {firstName}!
          </Heading>
          <Text style={{ fontSize: "16px", color: "#374151", lineHeight: "1.6" }}>
            Your account has been created and is ready to use.
            {trialDays !== undefined && trialDays > 0
              ? ` You have a ${trialDays}-day free trial to explore everything ${productName} has to offer.`
              : ""}
          </Text>
          <Text style={{ fontSize: "16px", color: "#374151", lineHeight: "1.6" }}>
            Get started by logging into your dashboard. You can set up your workspace, invite team
            members, and begin using {productName} right away.
          </Text>
          <Button
            href={loginUrl}
            style={{
              backgroundColor: "#4f46e5",
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
            Go to Dashboard
          </Button>
          <Hr style={{ borderColor: "#e5e7eb", margin: "24px 0" }} />
          <Text style={{ fontSize: "14px", color: "#6b7280" }}>
            If you have any questions, reply to this email or contact our support team. We&apos;re
            here to help.
          </Text>
          <Text style={{ fontSize: "14px", color: "#6b7280" }}>— The {productName} Team</Text>
        </Container>
      </Body>
    </Html>
  );
}
