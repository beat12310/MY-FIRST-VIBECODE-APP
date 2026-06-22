/**
 * Server-side Cognito JWT verification.
 *
 * Reads the Authorization: Bearer <token> header, verifies the signature
 * against Cognito's public JWKS, and returns the authenticated user's sub
 * (Cognito user sub — stable unique identifier, never changes).
 *
 * The sub is used as ownerUserId throughout the platform.
 */

import { NextRequest } from 'next/server';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

const REGION = process.env.NEXT_PUBLIC_AWS_REGION ?? 'us-east-1';
const USER_POOL_ID = process.env.NEXT_PUBLIC_USER_POOL_ID ?? '';
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;

// jose caches the remote fetch internally — re-using across requests is safe.
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!_jwks && USER_POOL_ID) {
    _jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
  }
  return _jwks;
}

export interface ServerAuthUser {
  /** Cognito user sub — stable unique ID, used as ownerUserId everywhere */
  sub: string;
  email?: string;
}

/**
 * Extract and verify the Cognito JWT from the Authorization header.
 * Returns null if the header is missing, malformed, or the token is invalid.
 */
export async function getAuthUser(request: NextRequest): Promise<ServerAuthUser | null> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  const jwks = getJwks();
  if (!jwks) return null; // USER_POOL_ID not set — auth not configured

  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER });
    if (!payload.sub) return null;
    return {
      sub: payload.sub,
      email: typeof (payload as JWTPayload & { email?: string }).email === 'string'
        ? (payload as JWTPayload & { email?: string }).email
        : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Like getAuthUser but returns 401 response directly when auth fails.
 * Use this in route handlers that strictly require authentication.
 */
export async function requireAuth(
  request: NextRequest,
): Promise<{ user: ServerAuthUser } | { error: Response }> {
  const user = await getAuthUser(request);
  if (!user) {
    return {
      error: new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }
  return { user };
}
