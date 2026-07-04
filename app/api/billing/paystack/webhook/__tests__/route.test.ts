import { describe, it, expect } from 'vitest';
import { PaystackWebhookSchema } from '../route';

describe('PaystackWebhookSchema (added 2026-07-04)', () => {
  // ROOT CAUSE this replaces: the webhook handler previously used ad-hoc
  // `typeof` checks with silent fallbacks — an invalid `purpose` value
  // (anything other than 'topup'/'subscription'/'domain') silently became
  // 'topup', and an invalid `amountUsd` silently became 0, instead of the
  // payload being rejected. For a route that moves real money, a malformed
  // field should fail loudly (400), not get quietly coerced into a
  // plausible-looking default that could credit the wrong bucket.
  it('accepts a well-formed charge.success payload', () => {
    const result = PaystackWebhookSchema.safeParse({
      event: 'charge.success',
      data: {
        reference: 'ref_123',
        status: 'success',
        metadata: { userId: 'user_1', purpose: 'topup', amountUsd: 10 },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid purpose value instead of silently defaulting to topup', () => {
    const result = PaystackWebhookSchema.safeParse({
      event: 'charge.success',
      data: {
        reference: 'ref_123',
        status: 'success',
        metadata: { userId: 'user_1', purpose: 'not-a-real-purpose', amountUsd: 10 },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-numeric amountUsd instead of silently defaulting to 0', () => {
    const result = PaystackWebhookSchema.safeParse({
      event: 'charge.success',
      data: {
        reference: 'ref_123',
        status: 'success',
        metadata: { userId: 'user_1', purpose: 'topup', amountUsd: 'ten dollars' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a payload with no metadata at all (non-charge events)', () => {
    const result = PaystackWebhookSchema.safeParse({ event: 'subscription.disable' });
    expect(result.success).toBe(true);
  });

  it('passes through unrecognized metadata fields rather than stripping them', () => {
    const result = PaystackWebhookSchema.safeParse({
      event: 'charge.success',
      data: { reference: 'ref_1', status: 'success', metadata: { userId: 'u1', someFutureField: 'x' } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data.data?.metadata as Record<string, unknown> | undefined)?.someFutureField).toBe('x');
    }
  });
});
