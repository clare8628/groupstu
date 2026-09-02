import { json, bad, readSession, loadState, applyDeadline, publicize } from './_lib.js';

/* GET /api/state — 公開讀取全部課程／名單／分組 */
export async function onRequestGet({ request, env }) {
  const db = env.DB;
  if (!db) return bad('D1 binding "DB" 未設定', 500);
  try {
    const session = await readSession(db, env, request);
    const courses = await applyDeadline(db, await loadState(db));
    return json({ courses: await publicize(db, env, courses, session), session });
  } catch (err) {
    return bad(String((err && err.message) || err), 500);
  }
}
