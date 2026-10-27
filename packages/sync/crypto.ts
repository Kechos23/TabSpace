import { z } from "zod";
const envelopeSchema = z
  .object({
    v: z.literal(1),
    salt: z.string().max(32),
    iv: z.string().max(24),
    data: z.string().max(32 * 1024 * 1024),
  })
  .strict();
const bytes = (value: Uint8Array) => new Uint8Array(value).buffer;
const encode = (value: Uint8Array) => {
  let s = "";
  for (let i = 0; i < value.length; i += 8192)
    s += String.fromCharCode(...value.subarray(i, i + 8192));
  return btoa(s);
};
const decode = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
export async function digest(value: Uint8Array) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(value))),
  )
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export async function vaultKey(passphrase: string, salt: Uint8Array) {
  if (passphrase.length < 12)
    throw new Error("Use a sync passphrase of at least 12 characters.");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", iterations: 310000, salt: bytes(salt) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function seal(value: Uint8Array, key: CryptoKey, context: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    key,
    bytes(value),
  );
  const result = new Uint8Array(12 + data.byteLength);
  result.set(iv);
  result.set(new Uint8Array(data), 12);
  return result;
}
export async function open(value: Uint8Array, key: CryptoKey, context: string) {
  if (value.length < 28) throw new Error("Incomplete encrypted sync file.");
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bytes(value.slice(0, 12)),
          additionalData: new TextEncoder().encode(context),
        },
        key,
        bytes(value.slice(12)),
      ),
    );
  } catch {
    throw new Error(
      "Cannot decrypt sync data. Check the passphrase; no data was replaced.",
    );
  }
}
export async function encodeDocument(
  value: unknown,
  key: CryptoKey,
  salt: Uint8Array,
) {
  const sealed = await seal(
    new TextEncoder().encode(JSON.stringify(value)),
    key,
    "TabSpace/sync/v1/manifest",
  );
  return new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      salt: encode(salt),
      iv: encode(sealed.slice(0, 12)),
      data: encode(sealed.slice(12)),
    }),
  );
}
export async function decodeDocument(value: Uint8Array, passphrase: string) {
  const envelope = envelopeSchema.parse(
    JSON.parse(new TextDecoder().decode(value)),
  );
  const salt = decode(envelope.salt),
    iv = decode(envelope.iv);
  if (salt.length !== 16 || iv.length !== 12)
    throw new Error("Invalid encrypted sync header.");
  const key = await vaultKey(passphrase, salt);
  const cipher = decode(envelope.data),
    combined = new Uint8Array(12 + cipher.length);
  combined.set(iv);
  combined.set(cipher, 12);
  return {
    value: JSON.parse(
      new TextDecoder().decode(
        await open(combined, key, "TabSpace/sync/v1/manifest"),
      ),
    ),
    key,
    salt,
  };
}
