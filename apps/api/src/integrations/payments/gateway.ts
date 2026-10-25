// Payment-gateway abstraction. Online payments are an extension point rather than a shipped feature: billing code
// depends only on this interface, so a gateway can be added later without touching invoices, payments or the ledger.
// A payment confirmed by a gateway is recorded exactly like a counter payment: POST /payments/collect with
// method "online" and the gateway's payment id as the reference.

export interface PaymentLinkRequest {
  amount: number;
  currency: string;
  customerName: string;
  customerPhone?: string | null;
  description: string;
  /** Our reference (e.g. invoice number) echoed back by the gateway. */
  reference: string;
}

export interface PaymentLink {
  url: string;
  gatewayId: string;
}

export interface PaymentGateway {
  readonly name: string;
  createPaymentLink(request: PaymentLinkRequest): Promise<PaymentLink>;
  /** Returns the gateway payment id when the signature is valid for the raw webhook body. */
  verifyWebhook(rawBody: string, signature: string): { paymentId: string; amount: number; reference: string } | null;
}

/** Default: no online gateway. Every payment is taken at the counter. */
export class ManualGateway implements PaymentGateway {
  readonly name = 'manual';
  async createPaymentLink(): Promise<PaymentLink> {
    throw new Error('Online payments are not enabled for this salon.');
  }
  verifyWebhook(): null {
    return null;
  }
}

export const PAYMENT_GATEWAYS = ['manual'] as const;

export function buildPaymentGateway(provider: string): PaymentGateway {
  switch (provider) {
    default:
      return new ManualGateway();
  }
}
