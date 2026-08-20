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

type PasswordResetProps = {
  resetUrl: string;
  firstName?: string;
  expiresIn?: string;
};

export default function PasswordReset(props: Record<string, unknown>) {
  const { resetUrl, firstName, expiresIn } = props as PasswordResetProps;

  return (
    <Html lang="en">
      <Head />
      <Preview>Reset your password — link expires {expiresIn ?? "in 1 hour"}</Preview>
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
            Reset your password
          </Heading>
          <Text style={{ fontSize: "16px", color: "#374151", lineHeight: "1.6" }}>
            {firstName ? `Hi ${firstName},` : "Hi,"} we received a request to reset the password for
            your account. Click the button below to choose a new password.
          </Text>
          <Button
            href={resetUrl}
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
            Reset Password
          </Button>
          <Text style={{ fontSize: "14px", color: "#6b7280" }}>
            This link will expire {expiresIn ?? "in 1 hour"}. If you did not request a password
            reset, you can safely ignore this email — your password will not change.
          </Text>
          <Hr style={{ borderColor: "#e5e7eb", margin: "24px 0" }} />
          <Text style={{ fontSize: "14px", color: "#6b7280" }}>
            For security, this link can only be used once.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
