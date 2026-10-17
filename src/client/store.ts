export type Status = 'todo' | 'doing' | 'done';
export type Task = {
  id: string;
  title: string;
  status: Status;
  position: number;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
};
export type User = { id: string; email: string; name: string; picture: string };

type Saved = { tasks: Task[]; dirty: string[]; cursor: number; user: User | null };

const KEY = 'flick:v1';
const DRAFT = 'flick:draft';

/** 端末内の保存（localStorage）。ログインしていなくても全部ここで動く */
class Store {
  readonly KEY = KEY;
  tasks = new Map<string, Task>();
  dirty = new Set<string>();
  cursor = 0;
  user: User | null = null;

  constructor() {
    this.load();
  }

  load() {
    try {
      const s: Saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!s) return;
      this.tasks = new Map(s.tasks.map((t) => [t.id, t]));
      this.dirty = new Set(s.dirty);
      this.cursor = s.cursor || 0;
      this.user = s.user;
    } catch {
      /* 壊れていたら空で始める */
    }
  }

  private save() {
    try {
      const s: Saved = { tasks: [...this.tasks.values()], dirty: [...this.dirty], cursor: this.cursor, user: this.user };
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* 容量不足・プライベートモード */
    }
  }

  loadDraft() {
    try {
      return localStorage.getItem(DRAFT) || '';
    } catch {
      return '';
    }
  }
  saveDraft(v: string) {
    try {
      localStorage.setItem(DRAFT, v);
    } catch {}
  }

  get(id: string) {
    return this.tasks.get(id);
  }

  byStatus(s: Status) {
    return [...this.tasks.values()].filter((t) => !t.deleted && t.status === s).sort((a, b) => b.position - a.position);
  }

  counts() {
    const c = { todo: 0, doing: 0, done: 0 };
    for (const t of this.tasks.values()) if (!t.deleted) c[t.status]++;
    return c;
  }

  maxPosition(s?: Status) {
    let m = 0;
    for (const t of this.tasks.values()) if (!t.deleted && (!s || t.status === s)) m = Math.max(m, t.position);
    return m;
  }

  create(title: string, position: number) {
    const now = Date.now();
    const t: Task = { id: crypto.randomUUID(), title, status: 'todo', position, createdAt: now, updatedAt: now };
    this.tasks.set(t.id, t);
    this.dirty.add(t.id);
    this.save();
    return t;
  }

  update(id: string, patch: Partial<Omit<Task, 'id'>>) {
    const t = this.tasks.get(id);
    if (!t) return;
    // 同じミリ秒に 2 回変えても後の変更が勝つよう、必ず時刻を進める
    Object.assign(t, patch, { updatedAt: Math.max(Date.now(), t.updatedAt + 1) });
    this.dirty.add(id);
    this.save();
  }

  remove(id: string) {
    this.update(id, { deleted: true });
  }

  dirtyTasks() {
    return [...this.dirty].map((id) => this.tasks.get(id)).filter((t): t is Task => !!t).map((t) => ({ ...t }));
  }
  dirtyCount() {
    return this.dirty.size;
  }

  /** サーバーの返答を取り込む。送ったあとに手元で変わったものは未送信のまま残す */
  applyServer(incoming: Task[], sent: Task[], now: number) {
    for (const s of sent) {
      const cur = this.tasks.get(s.id);
      if (cur && cur.updatedAt === s.updatedAt) this.dirty.delete(s.id);
    }
    let changed = false;
    for (const t of incoming) {
      const cur = this.tasks.get(t.id);
      if (cur && cur.updatedAt >= t.updatedAt) continue;
      if (this.dirty.has(t.id)) continue;
      this.tasks.set(t.id, t);
      changed = true;
    }
    // 削除済みは同期が終わったら端末から消してよい
    for (const [id, t] of this.tasks) if (t.deleted && !this.dirty.has(id)) this.tasks.delete(id);
    this.cursor = now;
    this.save();
    return changed;
  }

  setUser(u: User | null) {
    this.user = u;
    this.save();
  }

  reset() {
    this.tasks.clear();
    this.dirty.clear();
    this.cursor = 0;
    this.user = null;
    this.save();
  }
}

export const store = new Store();
