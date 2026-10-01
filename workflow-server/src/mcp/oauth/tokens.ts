import { createHash, hkdfSync, randomUUID } from 'node:crypto';
import { CompactEncrypt, compactDecrypt, jwtVerify, SignJWT, type JWTPayload } from 'jose';

// Stateless token primitives for the MCP OAuth proxy. Nothing is stored server-side: registered
// clients, pending authorizations, codes and tokens are all signed (JWS) or, when they carry an
// Entra refresh token, encrypted (JWE) with keys derived from MCP_OAUTH_SIGNING_SECRET. Each
// artifact has its own `typ` so one kind can never be replayed as another.

export type TokenKind = 'client' | 'state' | 'code' | 'access' | 'refresh';

const LIFETIME_SECONDS: Record<TokenKind, number> = {
  client: 10 * 365 * 24 * 60 * 60, // DCR client ids are long-lived; rotate the secret to revoke.
  state: 10 * 60,
  code: 5 * 60,
  access: 60 * 60,
  refresh: 90 * 24 * 60 * 60,
};

const ENCRYPTED_KINDS = new Set<TokenKind>(['code', 'refresh']);

export interface OAuthKeys {
  signing: Uint8Array;
  encryption: Uint8Array;
}

export function deriveOAuthKeys(secret: string): OAuthKeys {
  if (secret.length < 32) throw new Error('MCP_OAUTH_SIGNING_SECRET must be at least 32 characters.');
  const derive = (info: string) => new Uint8Array(hkdfSync('sha256', secret, 'meeting-note-mcp-oauth', info, 32));
  return { signing: derive('jws-hs256'), encryption: derive('jwe-a256gcm') };
}

export async function issueToken(
  keys: OAuthKeys,
  kind: TokenKind,
  issuer: string,
  claims: Record<string, unknown>,
  audience?: string,
): Promise<string> {
  let jwt = new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: kind })
    .setIssuer(issuer)
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(`${LIFETIME_SECONDS[kind]}s`);
  if (audience) jwt = jwt.setAudience(audience);
  const signed = await jwt.sign(keys.signing);
  if (!ENCRYPTED_KINDS.has(kind)) return signed;
  return new CompactEncrypt(new TextEncoder().encode(signed))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', cty: 'JWT' })
    .encrypt(keys.encryption);
}

// Returns the payload, or undefined when the token is malformed, tampered, expired, of another
// kind, or minted for another issuer/audience.
export async function verifyToken(
  keys: OAuthKeys,
  kind: TokenKind,
  token: string,
  issuer: string,
  audience?: string,
): Promise<JWTPayload | undefined> {
  try {
    let signed = token;
    if (ENCRYPTED_KINDS.has(kind)) {
      const { plaintext } = await compactDecrypt(token, keys.encryption);
      signed = new TextDecoder().decode(plaintext);
    }
    const { payload, protectedHeader } = await jwtVerify(signed, keys.signing, {
      algorithms: ['HS256'],
      issuer,
      ...(audience ? { audience } : {}),
    });
    if (protectedHeader.typ !== kind) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

// RFC 7636 S256: BASE64URL(SHA256(code_verifier)) must equal the stored code_challenge.
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) return false;
  return createHash('sha256').update(codeVerifier).digest('base64url') === codeChallenge;
}

// Single-use guard for authorization codes. In-memory is enough for the single Render instance;
// entries live only as long as a code can (5 min). A restart inside that window could let a
// stolen code be redeemed once more, but the code is still bound to the client's PKCE verifier.
const usedCodeIds = new Map<string, number>();

export function consumeCodeId(jti: string, expiresAtSeconds: number): boolean {
  const now = Date.now() / 1000;
  for (const [id, exp] of usedCodeIds) if (exp < now) usedCodeIds.delete(id);
  if (usedCodeIds.has(jti)) return false;
  usedCodeIds.set(jti, expiresAtSeconds);
  return true;
}
