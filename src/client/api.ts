import type { Task, User } from './store';

export class Unauthorized extends Error {}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-ft': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export const api = {
  me: () => call<User>('/api/me'),
  sync: (since: number, changes: Task[]) => call<{ now: number; tasks: Task[] }>('/api/sync', { since, changes }),
  organize: (text: string) => call<{ source: 'ai' | 'fallback'; titles: string[] }>('/api/ai/organize', { text }),
  logout: () => fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }),
};
