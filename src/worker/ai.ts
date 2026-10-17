import type { Env } from './index';

const SYSTEM = `あなたはタスク整理アシスタントです。
ユーザーの走り書きメモを、すぐ行動できる短いタスクに分けてください。
- 1タスクは40文字以内の日本語。動詞で終える（例：「牛乳を買う」）
- 重複はまとめる。挨拶や感想など行動でない文は捨てる
- 最大12件。メモの順番を保つ
JSON {"tasks": ["...", "..."]} だけを返してください。`;

const SCHEMA = {
  type: 'object',
  properties: { tasks: { type: 'array', items: { type: 'string' } } },
  required: ['tasks'],
};

/** AI が使えないとき用。改行・読点・箇条書き記号で区切るだけの簡易分割 */
export function splitFallback(text: string): string[] {
  return text
    .split(/\r?\n|。|、|;|；/)
    .map((s) => s.replace(/^\s*(?:[-*・●○□■✓✔]|\d+[.)．])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 12);
}

function clean(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((s): s is string => typeof s === 'string').map((s) => s.trim().slice(0, 80)))]
    .filter(Boolean)
    .slice(0, 12);
}

export async function organize(env: Env, text: string): Promise<{ source: 'ai' | 'fallback'; titles: string[] }> {
  if (env.AI) {
    try {
      const out: any = await env.AI.run(env.AI_MODEL as any, {
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: text },
        ],
        response_format: { type: 'json_schema', json_schema: SCHEMA },
        max_tokens: 600,
        temperature: 0.2,
      } as any);
      const raw = out?.response;
      const parsed = typeof raw === 'string' ? JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) : raw;
      const titles = clean(parsed?.tasks);
      if (titles.length) return { source: 'ai', titles };
    } catch (e) {
      console.warn('Workers AI failed, using fallback', e);
    }
  }
  return { source: 'fallback', titles: splitFallback(text) };
}
