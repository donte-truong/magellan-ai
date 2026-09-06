import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Opt-in instrumentation for the live HTTP test only. Preserve final content,
// excluding hidden reasoning and request headers/credentials.
const directory = process.env.BOM_RESPONSE_CAPTURE_DIR;
if (directory) {
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await original(...args);
    const url = String(args[0] instanceof Request ? args[0].url : args[0]);
    if (url === 'https://openrouter.ai/api/v1/chat/completions') {
      const reader = response.clone().body?.getReader();
      const chunks = []; let size = 0;
      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2_000_000) { void reader.cancel(); throw new Error('Model response capture exceeds 2 MB'); }
          chunks.push(value);
        }
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const prefix = `${Date.now()}-${randomUUID()}`;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      let parsed; try { parsed = JSON.parse(raw); } catch { /* retain invalid provider response */ }
      const error = !response.ok || !!parsed?.error || !parsed;
      if (error) await writeFile(join(directory, `${prefix}.provider-error.txt`), raw, { mode: 0o600 });
      for (const [i, choice] of (parsed?.choices ?? []).entries()) {
        if (typeof choice.message?.content === 'string') {
          await writeFile(join(directory, `${prefix}.choice-${i}.final.txt`), choice.message.content, { mode: 0o600 });
        }
      }
      await writeFile(join(directory, `${prefix}.metadata.json`), JSON.stringify({ at: new Date().toISOString(), http_status: response.status, response_id: parsed?.id, model: parsed?.model, error, finish_reasons: parsed?.choices?.map(c => c.finish_reason) }, null, 2), { mode: 0o600 });
    }
    return response;
  };
}
