/**
 * `POST /api/upload` — the only endpoint in the app that writes outside
 * `./data/` (SPEC-006).
 *
 * > `/api/upload` | POST | `multipart/form-data`: `file`, `kind` ∈
 * > `avatar|cover|inline` | `201 { path, width, height }` or `400 { error }`
 *
 * The route itself is deliberately thin. Every decision it makes lives in
 * `lib/media/*` as a pure or near-pure function, and the handler's whole job is
 * ordering them and turning a rejection into a status code. That split is not
 * ceremony: a rule that can only be exercised by standing up a Next server gets
 * one happy-path test, whereas `validateUpload` and `allocate` get enumerated
 * exhaustively in milliseconds.
 *
 * ── `handleUpload` is exported, and that is the point ──────────────────────
 * `POST` resolves the session and hands it to `handleUpload`. The tests call
 * `handleUpload` directly with a fixture user.
 *
 * (Imports here are relative rather than `@/`-aliased. The alias is a tsconfig
 * path that Next resolves and `vitest.config.ts` — owned by SPEC-002 — does
 * not, so an aliased import would make this module unloadable from a unit test.
 * Relative specifiers work in both.)
 *
 * This is not a testing shortcut around the authorization — it is what makes
 * the authorization testable at all. `auth()` reaches for `next/headers`, which
 * throws outside a request scope, so a handler that resolved its own session
 * inline could only be tested by mocking the session module — and a mocked
 * guard proves nothing about the guard. With the session as a parameter, the
 * suites pass a *real* `SessionUser`, including `null` for anonymous and a
 * second user for the cross-user case, and assert the real branch. `POST` is
 * then a two-line adapter with nothing in it to get wrong.
 *
 * ── Status codes ──────────────────────────────────────────────────────────
 * SPEC-006's response column names 201/400 and `approach.md` widens it to
 * `201 { path, width, height } | 400/403/413/415`. The ordering below is the
 * order the spec states its rules, and it is load-bearing in one place: size is
 * checked before content, so a 6 MB PDF answers 413 (the oracle's expectation)
 * rather than 415. 401 is added for the anonymous case — `approach.md`'s
 * Identity→Media interface says "401/403 when absent/mismatched", so absent and
 * mismatched are different answers, and collapsing them into 403 would tell a
 * signed-out user they lack permission when what they lack is a session.
 */

import { auth, type SessionUser } from '../../../lib/auth/session';
import { processImage } from '../../../lib/media/process';
import { storeImage } from '../../../lib/media/store';
import { MAX_UPLOAD_BYTES, UploadRejected, validateUpload } from '../../../lib/media/validate';

/**
 * sharp is a native module and the pipeline writes to the local filesystem;
 * neither survives the edge runtime. Stating it here means a future
 * `export const runtime = 'edge'` added elsewhere cannot silently apply.
 */
export const runtime = 'nodejs';

/** An upload is a mutation. Nothing about this response is cacheable. */
export const dynamic = 'force-dynamic';

/** The JSON body of a failed upload. */
interface ErrorBody {
  error: string;
  code: string;
}

function fail(status: number, code: string, error: string): Response {
  return Response.json({ error, code } satisfies ErrorBody, { status });
}

/**
 * The minimum of `File` this handler uses.
 *
 * Typed structurally rather than as `File` because the value comes out of
 * `FormData.get()` as `FormDataEntryValue`, and because the tests construct
 * uploads with the platform `File` from `node:buffer` — which is the same shape
 * without being the same nominal type on every Node version.
 */
interface UploadedFile {
  size: number;
  name?: string;
  type?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isUploadedFile(value: unknown): value is UploadedFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as UploadedFile).arrayBuffer === 'function' &&
    typeof (value as UploadedFile).size === 'number'
  );
}

/**
 * The handler proper, with the session injected.
 *
 * @param user the resolved session user, or `null` for an anonymous request.
 */
export async function handleUpload(request: Request, user: SessionUser | null): Promise<Response> {
  // 1. A session, before anything else is read. An anonymous request must not
  //    be able to make the server parse a 5 MB multipart body.
  if (!user) {
    return fail(401, 'unauthenticated', 'You must be signed in to upload an image.');
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, 'bad_body', 'Expected a multipart/form-data body.');
  }

  // 2. Ownership, before any byte is decoded. `owner` is the directory the
  //    caller is asking to write into; it defaults to the caller's own id, so
  //    an honest client never sends it. A client that DOES send it is either a
  //    later slice being explicit or someone trying to write into another
  //    user's directory, and those two cases are distinguished by exactly one
  //    comparison. SPEC-006: "kind=avatar|cover writes only under the session
  //    user's own id; a mismatch is 403."
  const requestedOwner = form.get('userId');
  const owner = typeof requestedOwner === 'string' && requestedOwner.length > 0
    ? requestedOwner
    : user.id;
  if (owner !== user.id) {
    return fail(403, 'not_owner', 'You can only upload into your own directory.');
  }

  const file = form.get('file');
  if (!isUploadedFile(file)) {
    return fail(400, 'missing_file', 'No `file` part was included in the upload.');
  }

  // 3. The declared size, before the body is materialised. `file.size` is known
  //    from the multipart framing, so an oversized upload is refused without
  //    ever holding its bytes — which is the only version of a size limit that
  //    is also a memory limit.
  if (file.size > MAX_UPLOAD_BYTES) {
    return fail(
      413,
      'too_large',
      `That image is too large. The limit is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`,
    );
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());

    // 4. Size again (the framing can lie) and then the magic-byte sniff. The
    //    client's `Content-Type` and filename are read by nothing: `file.name`
    //    is never passed to any path operation, which is why
    //    `../../../etc/passwd.png` has nowhere to go.
    const validated = validateUpload({ bytes, kind: form.get('kind'), declaredSize: file.size });

    // 5. Decode → orient → resize → re-encode as WebP. The stored bytes are
    //    produced here, not received; EXIF (including GPS) does not survive.
    const processed = await processImage(bytes, validated.kind);

    // 6. Only now does anything touch the disk, under a server-generated name
    //    in the session user's own directory.
    const stored = await storeImage({
      kind: validated.kind,
      userId: user.id,
      data: processed.data,
      width: processed.width,
      height: processed.height,
    });

    return Response.json(
      { path: stored.path, width: stored.width, height: stored.height },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof UploadRejected) {
      return fail(error.status, error.code, error.message);
    }
    // Anything else is ours, not the caller's. The detail stays in the server
    // log; the response says nothing about paths or module internals.
    console.error('[upload] unexpected failure', error);
    return fail(500, 'internal', 'The upload could not be completed.');
  }
}

export async function POST(request: Request): Promise<Response> {
  const session = await auth();
  return handleUpload(request, session?.user ?? null);
}
