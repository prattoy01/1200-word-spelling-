import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';

declare global {
  var _postgresPool: Pool | undefined;
}

export function isTransientPgError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { message?: string; code?: string; cause?: unknown };
  const msg = String(anyErr?.message || '');
  const code = String(anyErr?.code || '');
  if (
    msg.includes('Connection terminated unexpectedly') ||
    msg.includes('Connection terminated') ||
    msg.includes('ECONNRESET') ||
    msg.includes('EPIPE') ||
    msg.includes('ETIMEDOUT') ||
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
        // Cloud SQL Developer / scale-to-zero terminates idle sockets gracefully; pg.Pool automatically replaces evicted clients on next query.
        console.warn(
          'Idle SQL pool client closed by database server (will reconnect automatically):',
          err.message
        );
        return;
      }
      console.error('SQL pool client error:', err);
    });
  }
  return global._postgresPool;
};

const pool = createPool();

export const db = drizzle(pool, { schema });
