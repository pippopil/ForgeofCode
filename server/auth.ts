import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config';
import { db } from './db';

export interface AuthUserPayload {
  sub: string;
  role: 'admin';
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUserPayload;
}

interface WsTicketEntry {
  username: string;
  expiresAt: number;
}

const wsTickets = new Map<string, WsTicketEntry>();

/** Проверяет, задан ли пароль администратора в env или уже создан в БД */
export function getAuthStatus(): {
  needsSetup: boolean;
  username: string;
  source: 'env_hash' | 'env_plain' | 'db' | 'unclaimed';
} {
  if (config.adminPasswordHash) {
    return { needsSetup: false, username: config.adminUsername, source: 'env_hash' };
  }
  if (config.adminPassword) {
    return { needsSetup: false, username: config.adminUsername, source: 'env_plain' };
  }
  const row = db.prepare(`SELECT username FROM admin_auth WHERE id = 1`).get() as
    | { username: string }
    | undefined;
  if (row) {
    return { needsSetup: false, username: row.username, source: 'db' };
  }
  return { needsSetup: true, username: config.adminUsername, source: 'unclaimed' };
}

/** Однократная инициализация администратора при первом запуске без .env пароля */
export async function claimInitialAdmin(username: string, password: string): Promise<string> {
  const status = getAuthStatus();
  if (!status.needsSetup) {
    throw new Error('Администратор уже настроен');
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO admin_auth (id, username, password_hash, updated_at) VALUES (1, ?, ?, ?)`
    )
    .run(username.trim() || config.adminUsername, passwordHash, now);

  if (info.changes === 0) {
    throw new Error('Администратор уже настроен');
  }
  return issueJwt(username.trim() || config.adminUsername);
}

/** Проверяет логин и пароль администратора (env имеет приоритет над БД) */
export async function verifyAdminCredentials(username: string, password: string): Promise<string | null> {
  const status = getAuthStatus();
  if (status.needsSetup) {
    return null;
  }

  if (status.source === 'env_hash') {
    if (username !== config.adminUsername) return null;
    const valid = await bcrypt.compare(password, config.adminPasswordHash);
    return valid ? issueJwt(username) : null;
  }

  if (status.source === 'env_plain') {
    if (username !== config.adminUsername) return null;
    const expected = Buffer.from(config.adminPassword, 'utf8');
    const actual = Buffer.from(password, 'utf8');
    if (expected.length !== actual.length) return null;
    const valid = crypto.timingSafeEqual(expected, actual);
    return valid ? issueJwt(username) : null;
  }

  const row = db
    .prepare(`SELECT username, password_hash FROM admin_auth WHERE id = 1`)
    .get() as { username: string; password_hash: string } | undefined;

  if (!row || row.username !== username) {
    return null;
  }
  const valid = await bcrypt.compare(password, row.password_hash);
  return valid ? issueJwt(username) : null;
}

export function issueJwt(username: string): string {
  const payload: AuthUserPayload = { sub: username, role: 'admin' };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: '24h' });
}

export function verifyJwtToken(token: string): AuthUserPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    if (typeof decoded === 'object' && decoded && decoded.sub && decoded.role === 'admin') {
      return { sub: String(decoded.sub), role: 'admin' };
    }
    return null;
  } catch {
    return null;
  }
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Требуется авторизация' });
    return;
  }
  const token = authHeader.slice(7).trim();
  const payload = verifyJwtToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Недействительный или истекший токен сессии' });
    return;
  }
  req.user = payload;
  next();
}

/** Создаёт одноразовый краткоживущий тикет для WebSocket-подключения */
export function createWsTicket(username: string): string {
  const now = Date.now();
  // Очищаем просроченные тикеты
  for (const [key, entry] of wsTickets.entries()) {
    if (entry.expiresAt < now) {
      wsTickets.delete(key);
    }
  }
  const ticket = crypto.randomBytes(24).toString('hex');
  wsTickets.set(ticket, { username, expiresAt: now + 30_000 });
  return ticket;
}

export function consumeWsTicket(ticket: string): string | null {
  const entry = wsTickets.get(ticket);
  if (!entry) return null;
  wsTickets.delete(ticket);
  if (entry.expiresAt < Date.now()) return null;
  return entry.username;
}
