/**
 * 授权失效提醒链接的签名令牌。
 *
 * 用途：授权失效提醒消息中的"重新授权"链接不依赖浏览器会话，
 * 由该签名令牌证明"此链接由系统为指定集成生成"。
 * 令牌不含可逆敏感信息，仅包含 integrationId 与过期时间，HMAC 签名防伪造。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getAppEncryptionKey } from '@/lib/platform/env';

export const REAUTH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function getSigningKey(): Buffer {
  return createHash('sha256').update(`feishu-reauth-link:${getAppEncryptionKey()}`).digest();
}

function sign(payload: string): string {
  return createHmac('sha256', getSigningKey()).update(payload).digest('base64url');
}

export function createReauthToken(integrationId: string, now = Date.now()): string {
  const payload = `${integrationId}.${now + REAUTH_TOKEN_TTL_MS}`;
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sign(payload)}`;
}

export function verifyReauthToken(token: string, now = Date.now()): { integrationId: string } | null {
  const [payloadPart, signaturePart] = token.split('.');
  if (!payloadPart || !signaturePart) return null;

  let payload: string;
  try {
    payload = Buffer.from(payloadPart, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expected = sign(payload);
  const provided = Buffer.from(signaturePart);
  const reference = Buffer.from(expected);
  if (provided.length !== reference.length || !timingSafeEqual(provided, reference)) return null;

  const dotIndex = payload.lastIndexOf('.');
  if (dotIndex <= 0) return null;
  const integrationId = payload.slice(0, dotIndex);
  const expiresAt = Number(payload.slice(dotIndex + 1));
  if (!integrationId || !Number.isFinite(expiresAt) || expiresAt <= now) return null;

  return { integrationId };
}
