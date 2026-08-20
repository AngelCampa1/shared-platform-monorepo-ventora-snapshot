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

type PaymentFailedProps = {
  updatePaymentUrl: string;
  amount: string;
  firstName?: string;
};

export default function PaymentFailed(props: Record<string, unknown>) {
  const { updatePaymentUrl, amount, firstName } = props as PaymentFailedProps;

  return (
    <Html lang="en">
      <Head />
      <Preview>
        Action required: Your payment of {amount} failed — please update your payment method.
      </Preview>
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
            Payment Failed
          </Heading>
          <Text style={{ fontSize: "16px", color: "#374151", lineHeight: "1.6" }}>
            {firstName ? `Hi ${firstName},` : "Hi,"} we were unable to process your payment of{" "}
            {amount}. This may be due to an expired card, insufficient funds, or a temporary issue
            with your payment method.
          </Text>
          <Text style={{ fontSize: "16px", color: "#374151", lineHeight: "1.6" }}>
            To keep your account active, please update your payment information as soon as possible.
          </Text>
          <Button
            href={updatePaymentUrl}
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
            Update Payment Method
          </Button>
          <Hr style={{ borderColor: "#e5e7eb", margin: "24px 0" }} />
          <Text style={{ fontSize: "14px", color: "#6b7280" }}>
            We will automatically retry the charge after your payment method is updated. If you
            continue to experience issues, please contact our support team.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
