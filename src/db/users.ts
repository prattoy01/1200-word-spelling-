import {
  db,
  isCloudSqlAvailable,
  isTransientPgError,
  markCloudSqlUnavailable,
} from './index.ts';
import { users } from './schema.ts';

export async function getOrCreateUser(
  uid: string,
  email: string,
  displayName = ''
) {
  if (!isCloudSqlAvailable()) {
    return {
      id: 0,
      uid,
      email,
      displayName,
      createdAt: new Date(),
    };
  }
  try {
    const result = await db
      .insert(users)
      .values({
        uid,
        email,
        displayName,
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          email,
          displayName,
        },
      })
      .returning();

    return result[0];
  } catch (error) {
    if (isTransientPgError(error)) {
      markCloudSqlUnavailable(60000);
      return {
        id: 0,
        uid,
        email,
        displayName,
        createdAt: new Date(),
      };
    }
    throw new Error('Failed to synchronize user account in database.', {
      cause: error,
    });
  }
}

export async function getUsers() {
  if (!isCloudSqlAvailable()) {
    return [];
  }
  try {
    return await db.select().from(users);
  } catch (error) {
    if (isTransientPgError(error)) {
      markCloudSqlUnavailable(60000);
      return [];
    }
    throw new Error('Database query failed. Please try again later.', {
      cause: error,
    });
  }
}
