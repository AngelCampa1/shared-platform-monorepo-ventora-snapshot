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

type PaymentReceiptProps = {
  amount: string;
  currency: string;
  planName: string;
  date: string;
  invoiceUrl?: string;
};

export default function PaymentReceipt(props: Record<string, unknown>) {
  const { amount, currency, planName, date, invoiceUrl } = props as PaymentReceiptProps;

  return (
    <Html lang="en">
      <Head />
      <Preview>
        Payment received — {currency} {amount} for {planName}
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
          <Heading style={{ fontSize: "24px", color: "#111827", marginBottom: "16px" }}>
            Payment Receipt
          </Heading>
          <Text style={{ fontSize: "16px", color: "#374151", lineHeight: "1.6" }}>
            Thank you for your payment. Here are the details of your transaction:
          </Text>
          <Container
            style={{
              backgroundColor: "#f3f4f6",
              borderRadius: "6px",
              padding: "20px",
              margin: "16px 0",
            }}
          >
            <Text style={{ fontSize: "14px", color: "#6b7280", margin: "0 0 4px 0" }}>Plan</Text>
            <Text
              style={{
                fontSize: "16px",
                color: "#111827",
                fontWeight: "600",
                margin: "0 0 16px 0",
              }}
            >
              {planName}
            </Text>
            <Text style={{ fontSize: "14px", color: "#6b7280", margin: "0 0 4px 0" }}>
              Amount Paid
            </Text>
            <Text
              style={{
                fontSize: "20px",
                color: "#111827",
                fontWeight: "700",
                margin: "0 0 16px 0",
              }}
            >
              {currency} {amount}
            </Text>
            <Text style={{ fontSize: "14px", color: "#6b7280", margin: "0 0 4px 0" }}>Date</Text>
            <Text style={{ fontSize: "16px", color: "#111827", margin: "0" }}>{date}</Text>
          </Container>
          {invoiceUrl !== undefined && invoiceUrl !== "" && (
            <Button
              href={invoiceUrl}
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
              Download Invoice
            </Button>
          )}
          <Hr style={{ borderColor: "#e5e7eb", margin: "24px 0" }} />
          <Text style={{ fontSize: "14px", color: "#6b7280" }}>
            Keep this email for your records. If you have any questions about this charge, please
            contact our support team.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
