import { expect, request } from "@playwright/test";

const backend = process.env.OPENOVERLAY_E2E_BACKEND_URL || `http://127.0.0.1:${Number(process.env.OPENOVERLAY_E2E_BACKEND_PORT) || 8734}`;
export const serviceAccount = { email: `service-${Date.now()}-${process.pid}@openoverlay.local`, password: "password123" };
let provisioned: Promise<void> | undefined;

// Church and navigation scenarios share a fixture account so a full run stays
// within the real signup limit. Each scenario still creates its own services.
export function ensureServiceAccount() {
  return (provisioned ??= (async () => {
    const api = await request.newContext();
    try {
      const response = await api.post(`${backend}/api/v1/auth/signup`, {
        headers: { "X-OpenOverlay-Api-Version": "v1" },
        data: serviceAccount
      });
      expect(response.status()).toBe(201);
    } finally {
      await api.dispose();
    }
  })());
}
