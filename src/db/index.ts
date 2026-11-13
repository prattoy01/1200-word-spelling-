import fs from 'fs';
import path from 'path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';

declare global {
  var _postgresPool: Pool | undefined;
}

let sqlUnavailableUntilMs = 0;

export function markCloudSqlUnavailable(durationMs = 60000): void {
  sqlUnavailableUntilMs = Date.now() + durationMs;
}

export function isCloudSqlAvailable(): boolean {
  if (Date.now() < sqlUnavailableUntilMs) {
    return false;
  }
  const sqlHost = process.env.SQL_HOST;
  if (!sqlHost || !process.env.SQL_USER || !process.env.SQL_DB_NAME) {
    return false;
  }
  if (sqlHost.startsWith('/')) {
    try {
      const socketPath = path.join(sqlHost, '.s.PGSQL.5432');
      if (!fs.existsSync(socketPath)) {
        markCloudSqlUnavailable(30000);
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

export function isTransientPgError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { message?: string; code?: string; cause?: unknown };
  const msg = String(anyErr?.message || '');
  const code = String(anyErr?.code || '');
  if (
    msg.includes('Connection terminated unexpectedly') ||
    msg.includes('Connection terminated') ||
    msg.includes('ENOENT') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('EPIPE') ||
    msg.includes('ETIMEDOUT') ||
    code === 'ENOENT' ||
    code === 'ECONNREFUSED' ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE'
  ) {
    return true;
  }
  return anyErr?.cause ? isTransientPgError(anyErr.cause) : false;
}

export const createPool = () => {
  if (!global._postgresPool) {
    global._postgresPool = new Pool({
      host: process.env.SQL_HOST,
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DB_NAME,
      max: 10,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 15000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      allowExitOnIdle: true,
    });

    global._postgresPool.on('error', (err) => {
      if (isTransientPgError(err)) {
        markCloudSqlUnavailable(30000);
        return;
      }
      console.warn('SQL pool client notice:', err.message);
    });
  }
  return global._postgresPool;
};

const pool = createPool();

export const db = drizzle(pool, { schema });
