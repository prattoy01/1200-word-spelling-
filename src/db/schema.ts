import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  displayName: text('display_name').default(''),
  role: text('role').default('user'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const contests = pgTable('contests', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  creatorId: text('creator_id').notNull(),
  creatorName: text('creator_name').notNull(),
  pageFilter: text('page_filter').notNull().default('all'),
  categoriesJson: text('categories_json').notNull().default('[]'),
  wordCount: integer('word_count').notNull().default(15),
  baseSeconds: integer('base_seconds').notNull().default(12),
  showBangla: boolean('show_bangla').notNull().default(false),
  startTimeMs: bigint('start_time_ms', { mode: 'number' }).notNull(),
  durationMinutes: integer('duration_minutes').notNull().default(30),
  randomSeed: text('random_seed').notNull(),
  status: text('status').notNull().default('active'),
  createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
  updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
});

export const contestSubmissions = pgTable('contest_submissions', {
  id: text('id').primaryKey(),
  contestId: text('contest_id').notNull(),
  userId: text('user_id').notNull(),
  userName: text('user_name').notNull(),
  userEmail: text('user_email').notNull().default(''),
  status: text('status').notNull().default('registered'),
  totalWords: integer('total_words').notNull().default(15),
  correctCount: integer('correct_count').notNull().default(0),
  accuracy: integer('accuracy').notNull().default(0),
  timeTakenMs: integer('time_taken_ms').notNull().default(0),
  resultsJson: text('results_json').notNull().default('[]'),
  createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
  updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
});

export const audioContributions = pgTable('audio_contributions', {
  id: text('id').primaryKey(),
  wordId: text('word_id').notNull(),
  word: text('word').notNull(),
  banglaMeaning: text('bangla_meaning').notNull().default(''),
  audioDataUrl: text('audio_data_url').notNull(),
  mimeType: text('mime_type').notNull().default('audio/wav'),
  fileName: text('file_name').notNull().default('audio.wav'),
  fileSize: integer('file_size').notNull().default(1024),
  durationMs: integer('duration_ms').notNull().default(1200),
  contributorId: text('contributor_id').notNull(),
  contributorName: text('contributor_name').notNull(),
  status: text('status').notNull().default('pending'),
  createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
  updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
});

export const recordings = pgTable('recordings', {
  wordId: text('word_id').primaryKey(),
  word: text('word').notNull(),
  banglaMeaning: text('bangla_meaning').notNull().default(''),
  audioDataUrl: text('audio_data_url').notNull(),
  mimeType: text('mime_type').notNull().default('audio/mpeg'),
  fileName: text('file_name').notNull().default('audio.mp3'),
  fileSize: integer('file_size').notNull().default(1024),
  durationMs: integer('duration_ms').notNull().default(1200),
  ownerId: text('owner_id').notNull(),
  ownerName: text('owner_name').notNull(),
  status: text('status').notNull().default('published'),
  updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
});

export const wordOverrides = pgTable('word_overrides', {
  wordId: text('word_id').primaryKey(),
  word: text('word').notNull(),
  bangla: text('bangla').notNull().default(''),
  updatedBy: text('updated_by').notNull().default('Admin'),
  status: text('status').notNull().default('published'),
  updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
});

export const personalWords = pgTable('personal_words', {
  id: text('id').primaryKey(),
  wordId: text('word_id').notNull(),
  word: text('word').notNull(),
  bangla: text('bangla').notNull().default(''),
  example: text('example').notNull().default(''),
  ownerId: text('owner_id').notNull(),
  status: text('status').notNull().default('active'),
  createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
  updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
});

export const contestsRelations = relations(contests, ({ many }) => ({
  submissions: many(contestSubmissions),
}));

export const contestSubmissionsRelations = relations(
  contestSubmissions,
  ({ one }) => ({
    contest: one(contests, {
      fields: [contestSubmissions.contestId],
      references: [contests.id],
    }),
  })
);
