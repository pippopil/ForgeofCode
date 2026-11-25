import crypto from 'node:crypto';

function deriveKey(masterKey: string): Buffer {
  return crypto.createHash('sha256').update(masterKey, 'utf8').digest();
}

/** Шифрует строку с помощью AES-256-GCM */
export function encryptSecret(plaintext: string, masterKey: string): string {
  const key = deriveKey(masterKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `gcm:v1:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/** Расшифровывает строку AES-256-GCM */
export function decryptSecret(payload: string, masterKey: string): string {
  if (!payload) return '';
  if (!payload.startsWith('gcm:v1:')) {
    return '';
  }
  const parts = payload.split(':');
  if (parts.length !== 5) return '';
  const [, , ivHex, tagHex, dataHex] = parts;
  try {
    const key = deriveKey(masterKey);
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(tagHex, 'hex');
    const encrypted = Buffer.from(dataHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return '';
  }
}

/** Удаляет известные секреты из логов и контекста LLM */
export function redactSecretsInText(text: string, secrets: Array<string | undefined | null>): string {
  let sanitized = text;
  for (const secret of secrets) {
    if (secret && secret.trim().length >= 6) {
      const escaped = secret.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      sanitized = sanitized.replace(new RegExp(escaped, 'g'), '[СКРЫТЫЙ_КЛЮЧ]');
    }
  }
  // Дополнительная очистка распространённых форматов ключей API
  sanitized = sanitized.replace(/\b(sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,})\b/g, '[СКРЫТЫЙ_КЛЮЧ]');
  return sanitized;
}
