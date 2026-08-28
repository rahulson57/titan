/**
 * Home route — PLACEHOLDER.
 *
 * ⚠️  TASK-007 (Feed & Search, SPEC-008) OWNS THIS FILE AND REPLACES IT WHOLESALE.
 *     Per DEC-007, the ranked home feed is built over this, not alongside it.
 *
 * Its only job is to make `/` resolve so S01's boot contract — HTTP 200 at
 * http://localhost:3000/ within 60s of a clean `npm run setup && npm run dev`
 * — can actually be executed rather than asserted on faith. See the note in
 * app/layout.tsx for why this lives in S01 at all.
 *
 * No tokens, no components, no styling: all of that is TASK-002's.
 */
export default function HomePage() {
  return (
    <main>
      <h1>titan</h1>
      <p>
        The runtime is up and serving on port 3000. The home feed lands with
        TASK-007.
      </p>
    </main>
  );
}
