import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { getAppEncryptionKey } from '@/lib/platform/env';

const ENCRYPTION_VERSION = 'enc-v1';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function encodeBase64Url(value: Buffer): string {
  return value.toString('base64url');
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function getAesKey(): Buffer {
  return createHash('sha256').update(getAppEncryptionKey()).digest();
}

export function encrypt(value: string): string {
  if (!value) {
    return '';
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', getAesKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    ENCRYPTION_VERSION,
    encodeBase64Url(iv),
    encodeBase64Url(authTag),
    encodeBase64Url(ciphertext),
  ].join(':');
}

export function decrypt(payload: string): string {
  if (!payload) {
    return '';
  }

  const [version, ivValue, authTagValue, ciphertextValue] = payload.split(':');
  if (
    version !== ENCRYPTION_VERSION ||
    !ivValue ||
    !authTagValue ||
    !ciphertextValue
  ) {
    throw new Error('密文字段格式不正确');
  }

  const iv = decodeBase64Url(ivValue);
  const authTag = decodeBase64Url(authTagValue);
  const ciphertext = decodeBase64Url(ciphertextValue);

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('密文字段长度不正确');
  }

  const decipher = createDecipheriv('aes-256-gcm', getAesKey(), iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function hashForLookup(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function createOpaqueToken(byteLength = 24): string {
  return randomBytes(byteLength).toString('base64url');
}

export function maskSecret(value: string | null | undefined, visibleTail = 4): string | null {
  if (!value) {
    return null;
  }

  if (value.length <= visibleTail) {
    return '*'.repeat(value.length);
  }

  return `${'*'.repeat(Math.max(value.length - visibleTail, 6))}${value.slice(-visibleTail)}`;
}
