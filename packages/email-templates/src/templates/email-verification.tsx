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

type EmailVerificationProps = {
  verifyUrl: string;
  firstName?: string;
};

export default function EmailVerification(props: Record<string, unknown>) {
  const { verifyUrl, firstName } = props as EmailVerificationProps;

  return (
    <Html lang="en">
      <Head />
      <Preview>Please verify your email address to complete your account setup.</Preview>
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
            Verify your email address
          </Heading>
          <Text style={{ fontSize: "16px", color: "#374151", lineHeight: "1.6" }}>
            {firstName ? `Hi ${firstName},` : "Hi,"} thanks for signing up! Please verify your email
            address by clicking the button below.
          </Text>
          <Text style={{ fontSize: "16px", color: "#374151", lineHeight: "1.6" }}>
            This helps us confirm your identity and keeps your account secure.
          </Text>
          <Button
            href={verifyUrl}
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
            Verify Email Address
          </Button>
          <Hr style={{ borderColor: "#e5e7eb", margin: "24px 0" }} />
          <Text style={{ fontSize: "14px", color: "#6b7280" }}>
            If you did not create an account, you can safely ignore this email.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
