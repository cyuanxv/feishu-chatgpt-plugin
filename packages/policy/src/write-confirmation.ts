import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { constantEquals, DomainError } from './core.js';

const claimSchema = z.object({
  v: z.literal(1), purpose: z.literal('confirm_create_doc'), intent: z.string().uuid(),
  binding: z.string().regex(/^[a-f0-9]{64}$/), request: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['approve', 'cancel']), expires: z.number().int().finite(),
}).strict();
type Claim = z.infer<typeof claimSchema>;

/** A trusted-host attestation, not a login mechanism or model-callable approval tool.
 * Only the reviewed UI/session/CSRF boundary may hold the signing key or call issue after
 * showing the exact preview and receiving the user's explicit decision. No runtime wires it yet. */
export class WriteConfirmationAuthority {
  private readonly key: Buffer;
  constructor(key: Buffer, private readonly now: () => number = Date.now) {
    if (key.length !== 32) throw new Error('A dedicated confirmation key is required.');
    this.key = Buffer.from(key);
  }
  issue(input: Omit<Claim, 'v' | 'purpose'>): string {
    const claim = claimSchema.parse({ ...input, v: 1, purpose: 'confirm_create_doc' });
    claim.expires = Math.min(claim.expires, this.now() + 600_000);
    if (claim.expires <= this.now()) throw new DomainError('INVALID_ARGUMENT', 'Confirmation lifetime is invalid.');
    const body = Buffer.from(JSON.stringify(claim)).toString('base64url');
    return body + '.' + createHmac('sha256', this.key).update(body).digest('base64url');
  }
  verify(proof: string, expected: Pick<Claim, 'intent' | 'binding' | 'request'>): Claim {
    const fail = () => new DomainError('PERMISSION_DENIED', 'Explicit trusted-host confirmation is required for this exact preview.');
    if (typeof proof !== 'string' || proof.length > 4096) throw fail();
    const [body, signature, extra] = proof.split('.');
    if (!body || !signature || extra || !/^[A-Za-z0-9_-]+$/.test(body) || !constantEquals(signature, createHmac('sha256', this.key).update(body).digest('base64url'))) throw fail();
    let claim: Claim;
    try { claim = claimSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))); } catch { throw fail(); }
    if (claim.intent !== expected.intent || claim.binding !== expected.binding || claim.request !== expected.request || claim.expires <= this.now() || claim.expires > this.now() + 600_000) throw fail();
    return claim;
  }
}
