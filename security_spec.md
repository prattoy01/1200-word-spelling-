# Security Specification (`security_spec.md`)

## 1. Data Invariants

1. **Default-Deny Catch-All**: All paths not explicitly matched in `firestore.rules` are unconditionally denied (`allow read, write: if false;`).
2. **Path Variable Hardening (`isValidId`)**: All document IDs (`{recordingId}`, `{sessionId}`) must be strings of length `1..128` matching `^[a-zA-Z0-9_\-]+$`. Furthermore, for `/recordings/{recordingId}`, `incoming().wordId == recordingId`.
3. **Identity & Verified Email Enforcement**: All write operations (`create`, `update`, `delete`) require an authenticated user (`request.auth != null`) with a verified email (`request.auth.token.email_verified == true`) and `incoming().ownerId == request.auth.uid`.
4. **Strict Schema & Volumetric Bounds (`isValidRecording`, `isValidPracticeSession`)**:
   - Every string field enforces explicit `.size()` lower and upper bounds matching `firebase-blueprint.json`.
   - Every document creation enforces `hasAll` and `hasOnly` on the exact required key set to block shadow/ghost fields.
5. **Temporal Integrity**: `createdAt` must equal `request.time` on `create` and remain immutable on `update`. `updatedAt` must equal `request.time` on `create` and `update`.
6. **Cross-Browser / Incognito Read Access with Query Enforcement**:
   - Published pronunciation recordings (`resource.data.status == 'published'`) can be read (`get` and `list`) across browsers and Incognito sessions only when the query explicitly filters on `status == 'published'` (or `ownerId == request.auth.uid` for signed-in owners).
   - `practiceSessions` are strictly private to their owner (`resource.data.ownerId == request.auth.uid`).

---

## 2. The "Dirty Dozen" Payloads

1. **Payload 1 (Identity Spoofing on Recording Create)**:
   `{ wordId: "weekdays", word: "weekdays", ownerId: "spoofed_uid_999", status: "published", ... }` -> Rejected because `incoming().ownerId != request.auth.uid`.
2. **Payload 2 (Unverified Email Write Attack)**:
   Authenticated user with `email_verified: false` attempting to create `/recordings/weekdays` -> Rejected by `isVerifiedUser()`.
3. **Payload 3 (Shadow / Ghost Field Injection on Create)**:
   Adding `"isAdmin": true` or `"isVerified": true` to `/recordings/weekdays` -> Rejected by `data.keys().hasOnly(...)`.
4. **Payload 4 (Update-Gap / Partial Update Type Poisoning)**:
   Updating `audioDataUrl` on `/recordings/weekdays` with a boolean `true` or 2MB string -> Rejected because `isValidRecording(incoming())` wraps the entire `allow update` rule.
5. **Payload 5 (ID Poisoning / Path Mismatch Attack)**:
   Creating `/recordings/bad$id!` or `/recordings/weekdays` with `wordId: "other_word"` -> Rejected by `isValidId(recordingId)` and `incoming().wordId == recordingId`.
6. **Payload 6 (Immortal Field Mutation on Recording Update)**:
   Attempting to mutate `createdAt`, `wordId`, or `ownerId` during an update -> Rejected by `affectedKeys().hasOnly(...)` and immutability checks.
7. **Payload 7 (Forged Client Timestamp Attack)**:
   Sending a past or future timestamp (`createdAt: Timestamp.fromMillis(1000)`) instead of `serverTimestamp()` (`request.time`) -> Rejected by `incoming().createdAt == request.time`.
8. **Payload 8 (Terminal / Archived State Mutation)**:
   Attempting to update a recording after its `status` is set to `'archived'` -> Rejected by `existing().status != 'archived'`.
9. **Payload 9 (Unfiltered Collection Scraping on `practiceSessions`)**:
   Executing `getDocs(collection(db, 'practiceSessions'))` without `where('ownerId', '==', uid)` -> Rejected by `resource.data.ownerId == request.auth.uid`.
10. **Payload 10 (Cross-User PracticeSession Read/Delete)**:
    User A attempting `getDoc` or `deleteDoc` on User B's `/practiceSessions/{sessionId}` -> Rejected by `existing().ownerId == request.auth.uid`.
11. **Payload 11 (Denial-of-Wallet Oversized String Payload)**:
    Sending a 2000-character `word` or 500-character `banglaMeaning` -> Rejected by strict `.size() <= 120` and `.size() <= 200` checks.
12. **Payload 12 (PracticeSession Mutation Attack)**:
    Attempting to `update` an existing `practiceSessions` document to inflate `accuracy: 100` -> Rejected because `allow update: if false;` on `practiceSessions`.
