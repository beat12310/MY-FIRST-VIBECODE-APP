'use client';

import { Amplify } from 'aws-amplify';

const userPoolId       = process.env.NEXT_PUBLIC_USER_POOL_ID;
const userPoolClientId = process.env.NEXT_PUBLIC_USER_POOL_CLIENT_ID;
const cognitoDomain    = process.env.NEXT_PUBLIC_COGNITO_DOMAIN;
const region           = process.env.NEXT_PUBLIC_AWS_REGION ?? 'us-east-1';

// ALL valid redirect origins listed explicitly.
// Amplify v6 picks the entry matching window.location.origin at sign-in time,
// so both dwomohvibe.com and www.dwomohvibe.com resolve to their own callback URL.
// This prevents PKCE state mismatches when the user navigates between subdomains.
const REDIRECT_SIGN_IN  = [
  'http://localhost:3000/auth/callback',
  'https://dwomohvibe.com/auth/callback',
  'https://www.dwomohvibe.com/auth/callback',
];
const REDIRECT_SIGN_OUT = [
  'http://localhost:3000/auth/signin',
  'https://dwomohvibe.com/auth/signin',
  'https://www.dwomohvibe.com/auth/signin',
];

if (userPoolId && userPoolClientId) {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId,
        loginWith: {
          email: true,
          oauth: cognitoDomain
            ? {
                domain:          cognitoDomain,
                scopes:          ['email', 'openid', 'profile'],
                redirectSignIn:  REDIRECT_SIGN_IN,
                redirectSignOut: REDIRECT_SIGN_OUT,
                responseType:    'code',
              }
            : undefined,
        },
        signUpVerificationMethod: 'code',
        userAttributes: {
          email: { required: true },
          name:  { required: false },
        },
      },
    },
  });
}

export const isAmplifyConfigured = Boolean(userPoolId && userPoolClientId);
export const isSocialConfigured  = Boolean(cognitoDomain);
export const cognitoRegion       = region;

export default function ConfigureAmplify() {
  return null;
}
