// Stop hook: once the conversation's context gets large, suggest starting a
// fresh session (each turn re-reads the whole context, so long sessions cost more).
// Reads the latest turn's token usage from the tail of the transcript.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const THRESHOLD = 150_000; // tokens of context per turn before the first nudge
const STEP = 100_000; // nudge again after this much more growth

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const file = input.transcript_path;
  if (!file || !fs.existsSync(file)) process.exit(0);

  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const len = Math.min(size, 512 * 1024);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);

  let context = 0;
  for (const line of buf.toString('utf8').split('\n').reverse()) {
    if (!line.includes('"usage"')) continue;
    try {
      const u = JSON.parse(line).message?.usage;
      if (!u) continue;
      context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      break;
    } catch {}
  }
  if (context < THRESHOLD) process.exit(0);

  // Only nudge once per STEP of growth, not after every reply.
  const state = path.join(os.tmpdir(), `claude-session-size-${input.session_id || 'x'}`);
  const last = Number(fs.existsSync(state) ? fs.readFileSync(state, 'utf8') : 0);
  if (last && context < last + STEP) process.exit(0);
  fs.writeFileSync(state, String(context));

  const k = Math.round(context / 1000);
  process.stdout.write(
    JSON.stringify({
      systemMessage: `This session is getting long (~${k}k tokens re-read each turn). Once this feature is finished and pushed, start a new session for the next one: it will be cheaper. CLAUDE.md carries the important context over.`,
    }),
  );
} catch {
  // Never get in the way of the session.
}
