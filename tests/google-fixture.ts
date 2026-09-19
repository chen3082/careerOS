import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { googleVerifier } from "../server/google-login.js";
export const testClient = "synthetic-careeros.apps.googleusercontent.com";
export async function googleFixture() {
  const pair = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "synthetic",
    alg: "RS256",
  };
  const sign = async (
    nonce: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: "https://accounts.google.com",
      aud: testClient,
      sub: "synthetic-subject",
      email: "synthetic@example.test",
      name: "Synthetic Applicant",
      email_verified: true,
      nonce,
      iat: now,
      exp: now + 600,
      ...overrides,
    })
      .setProtectedHeader({ alg: "RS256", kid: "synthetic" })
      .sign(pair.privateKey);
  };
  return {
    sign,
    verify: googleVerifier(testClient, createLocalJWKSet({ keys: [jwk] })),
  };
}
