import { store, type Task, type Status } from './store';
import { api, Unauthorized } from './api';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const haptic = () => navigator.vibrate?.(8);

const VIEWS: Status[] = ['todo', 'doing', 'done'];
const LABEL: Record<Status, string> = { todo: '未着手', doing: '進行中', done: '完了' };
const COLOR: Record<Status | 'delete', string> = {
  todo: 'var(--blue)',
  doing: 'var(--orange)',
  done: 'var(--green)',
  delete: 'var(--red)',
};
const ICON = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/></svg>',
  person: '<svg viewBox="0 0 24 24"><path d="M12 12a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4zm0 2.2c-4.4 0-8 2.3-8 5.1V21h16v-1.7c0-2.8-3.6-5.1-8-5.1z"/></svg>',
  empty: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="5"/><path d="M8.5 12.2l2.4 2.4 4.6-4.9"/></svg>',
  google:
    '<svg viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>',
};

/** スワイプ方向ごとの移動先。右＝進める、左＝戻す（未着手で左は削除） */
function swipeTarget(s: Status, dir: 1 | -1): Status | 'delete' | null {
  const i = VIEWS.indexOf(s) + dir;
  if (i < 0) return 'delete';
  return VIEWS[i] ?? null;
}

let view: Status = 'todo';
let ready = false;

const list = $('#list');
const memo = $<HTMLTextAreaElement>('#memo');
const composer = $<HTMLFormElement>('#composer');
const addBtn = $<HTMLButtonElement>('#addBtn');
const aiBtn = $<HTMLButtonElement>('#aiBtn');
const rows = new Map<string, HTMLElement>();

// ---------- メモ欄（最初の 1 フレーム目から入力できる） ----------

memo.focus({ preventScroll: true });

function autosize() {
  memo.style.height = 'auto';
  memo.style.height = memo.scrollHeight + 'px';
  const has = memo.value.trim().length > 0;
  addBtn.disabled = !has;
  aiBtn.disabled = !has;
}
memo.addEventListener('input', () => {
  autosize();
  store.saveDraft(memo.value);
});
memo.value = store.loadDraft();
autosize();

memo.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = memo.value.trim();
  if (!text) return;
  addTasks([text]);
  memo.value = '';
  store.saveDraft('');
  autosize();
  memo.focus();
});

aiBtn.addEventListener('click', async () => {
  const text = memo.value.trim();
  if (!text) return;
  if (!store.user) {
    openAccount('AI を使うにはログインしてください');
    return;
  }
  composer.classList.add('thinking');
  aiBtn.disabled = true;
  try {
    const res = await api.organize(text);
    if (!res.titles.length) throw new Error('empty');
    addTasks(res.titles);
    memo.value = '';
    store.saveDraft('');
    toast(res.source === 'ai' ? `${res.titles.length}件に分けました` : `AIが使えないため区切りで${res.titles.length}件に分けました`);
  } catch (err) {
    if (err instanceof Unauthorized) onUnauthorized();
    toast('分けられませんでした');
  } finally {
    composer.classList.remove('thinking');
    autosize();
    memo.focus();
  }
});

function addTasks(titles: string[]) {
  const top = store.maxPosition();
  // 先頭の行が一番上に来るよう、後ろから順に大きい position を振る
  titles.forEach((title, i) => store.create(title, top + titles.length - i));
  if (view !== 'todo') setView('todo');
  else render({ stagger: true });
  bumpCounts();
  haptic();
  scheduleSync();
}

// ---------- 一覧の描画（FLIP で並び替えをアニメーション） ----------

function rowFor(t: Task) {
  let el = rows.get(t.id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'row';
    el.dataset.id = t.id;
    el.innerHTML = `
      <div class="row-bg"><span class="hint l"></span><span class="hint r"></span></div>
      <div class="card glass" tabindex="0" role="button">
        <button class="check" type="button">${ICON.check}</button>
        <div class="title"></div>
        <div class="desk">
          <button type="button" class="prev"></button>
          <button type="button" class="next"></button>
        </div>
      </div>`;
    bindRow(el);
    rows.set(t.id, el);
  }
  el.dataset.status = t.status;
  el.querySelector('.title')!.textContent = t.title;
  const check = el.querySelector<HTMLButtonElement>('.check')!;
  check.setAttribute('aria-label', t.status === 'done' ? '未着手に戻す' : '完了にする');
  const prev = el.querySelector<HTMLButtonElement>('.prev')!;
  const next = el.querySelector<HTMLButtonElement>('.next')!;
  const p = swipeTarget(t.status, -1);
  const n = swipeTarget(t.status, 1);
  prev.innerHTML = p === 'delete' ? ICON.trash : ICON.left;
  prev.setAttribute('aria-label', p === 'delete' ? '削除' : `${LABEL[p!]}へ`);
  next.hidden = !n;
  next.innerHTML = ICON.right;
  next.setAttribute('aria-label', n ? `${LABEL[n as Status]}へ` : '');
  return el;
}

function render(opts: { stagger?: boolean; slide?: 'l' | 'r' } = {}) {
  if (!ready) return;
  const tasks = store.byStatus(view);
  const before = new Map<string, DOMRect>();
  for (const [id, el] of rows) if (el.isConnected) before.set(id, el.getBoundingClientRect());

  const keep = new Set(tasks.map((t) => t.id));
  for (const [id, el] of rows) {
    if (!keep.has(id)) {
      el.remove();
      rows.delete(id);
    }
  }
  list.querySelector('.empty')?.remove();

  let enterIndex = 0;
  tasks.forEach((t, i) => {
    const el = rowFor(t);
    const isNew = !before.has(t.id);
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] ?? null);
    if (isNew && !opts.slide && !reduceMotion) {
      el.classList.remove('enter');
      void el.offsetWidth;
      el.style.animationDelay = opts.stagger ? `${enterIndex++ * 55}ms` : '0ms';
      el.classList.add('enter');
      el.addEventListener('animationend', () => el.classList.remove('enter'), { once: true });
    }
  });

  if (!tasks.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.innerHTML = ICON.empty;
    e.setAttribute('aria-label', `${LABEL[view]}のタスクはありません`);
    list.append(e);
  }

  if (opts.slide && !reduceMotion) {
    list.classList.remove('slide-l', 'slide-r');
    void list.offsetWidth;
    list.classList.add(`slide-${opts.slide}`);
    setTimeout(() => list.classList.remove('slide-l', 'slide-r'), 480);
  } else if (!reduceMotion) {
    // FLIP：位置が変わった行を、元の位置から滑らかに移動させる
    for (const [id, rect] of before) {
      const el = rows.get(id);
      if (!el) continue;
      const dy = rect.top - el.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) {
        el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
          duration: 480,
          easing: 'cubic-bezier(0.34, 1.4, 0.64, 1)',
        });
      }
    }
  }
  renderCounts();
}

let lastCounts: Record<Status, number> | null = null;
function renderCounts() {
  const c = store.counts();
  for (const s of VIEWS) {
    const el = document.querySelector(`.tab[data-view="${s}"] .count`)!;
    el.textContent = String(c[s]);
    if (lastCounts && lastCounts[s] !== c[s] && !reduceMotion) {
      el.classList.remove('bump');
      void (el as HTMLElement).offsetWidth;
      el.classList.add('bump');
    }
  }
  lastCounts = c;
}
const bumpCounts = renderCounts;

// ---------- タブ ----------

const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tab')];
const thumb = $('.tab-thumb');
function setView(next: Status) {
  const from = VIEWS.indexOf(view);
  const to = VIEWS.indexOf(next);
  view = next;
  tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === next)));
  thumb.style.transform = `translateX(${to * 100}%)`;
  $('#viewTitle').innerHTML = `<span class="t">${LABEL[next]}</span>`;
  for (const el of rows.values()) el.remove();
  rows.clear();
  render({ slide: to === from ? undefined : to > from ? 'l' : 'r' });
}
tabs.forEach((t) =>
  t.addEventListener('click', () => {
    if (t.dataset.view !== view) {
      haptic();
      setView(t.dataset.view as Status);
    }
  })
);

// ---------- ステータス変更（スワイプ・ボタン・キーボード共通） ----------

function applyMove(id: string, target: Status | 'delete', el?: HTMLElement) {
  const t = store.get(id);
  if (!t) return;
  const prev = { status: t.status, deleted: !!t.deleted };
  if (target === 'delete') store.remove(id);
  else store.update(id, { status: target, position: store.maxPosition(target) + 1 });
  haptic();
  scheduleSync();

  const finish = () => render();
  if (el && !reduceMotion) collapse(el).then(finish);
  else finish();

  toast(target === 'delete' ? '削除しました' : `${LABEL[target]}にしました`, () => {
    store.update(id, { status: prev.status, deleted: prev.deleted });
    render();
    scheduleSync();
  });
}

/** 行を畳んで消す（飛ばしたあとに使う） */
function collapse(el: HTMLElement) {
  const h = el.offsetHeight;
  return el
    .animate(
      [
        { height: h + 'px', marginBottom: '0px', opacity: 1 },
        { height: '0px', marginBottom: '-10px', opacity: 0 },
      ],
      { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' }
    )
    .finished.then(() => {
      el.remove();
      rows.delete(el.dataset.id!);
    });
}

function bindRow(row: HTMLElement) {
  const card = row.querySelector<HTMLElement>('.card')!;
  const bg = row.querySelector<HTMLElement>('.row-bg')!;
  const hintL = bg.querySelector<HTMLElement>('.hint.l')!;
  const hintR = bg.querySelector<HTMLElement>('.hint.r')!;
  const id = row.dataset.id!;

  row.querySelector('.check')!.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = store.get(id)!;
    applyMove(id, t.status === 'done' ? 'todo' : 'done', row);
  });
  row.querySelector('.prev')!.addEventListener('click', (e) => {
    e.stopPropagation();
    const target = swipeTarget(store.get(id)!.status, -1);
    if (target) flyOut(-1, target);
  });
  row.querySelector('.next')!.addEventListener('click', (e) => {
    e.stopPropagation();
    const target = swipeTarget(store.get(id)!.status, 1);
    if (target) flyOut(1, target);
  });
  card.addEventListener('keydown', (e) => {
    if (e.target !== card) return;
    const s = store.get(id)!.status;
    if (e.key === 'ArrowRight' && swipeTarget(s, 1)) flyOut(1, swipeTarget(s, 1)!);
    else if (e.key === 'ArrowLeft') flyOut(-1, swipeTarget(s, -1)!);
    else if (e.key === 'Delete' || e.key === 'Backspace') flyOut(-1, 'delete');
    else if (e.key === 'Enter') openEditor(id);
    else return;
    e.preventDefault();
  });

  function flyOut(dir: 1 | -1, target: Status | 'delete') {
    if (reduceMotion) return applyMove(id, target);
    paintBg(dir, target, true);
    row.classList.add('swiping');
    card
      .animate([{ transform: getComputedStyle(card).transform === 'none' ? 'none' : getComputedStyle(card).transform }, { transform: `translateX(${dir * 115}%) rotate(${dir * 4}deg)` }], {
        duration: 300,
        easing: 'cubic-bezier(0.4, 0, 0.6, 1)',
        fill: 'forwards',
      })
      .finished.then(() => applyMove(id, target, row));
  }

  function paintBg(dir: number, target: Status | 'delete' | null, on: boolean) {
    bg.style.backgroundColor = target ? COLOR[target] : 'rgba(118,118,128,.25)';
    bg.style.justifyContent = dir > 0 ? 'flex-start' : 'flex-end';
    const hint = dir > 0 ? hintR : hintL;
    (dir > 0 ? hintL : hintR).style.display = 'none';
    hint.style.display = '';
    hint.innerHTML = target
      ? target === 'delete'
        ? `${ICON.trash}削除`
        : dir > 0
          ? `${LABEL[target]}${ICON.right}`
          : `${ICON.left}${LABEL[target]}`
      : '';
    hint.classList.toggle('on', on);
  }

  // フリック操作：横に動いたときだけ掴む。縦はスクロールに任せる
  let startX = 0, startY = 0, dx = 0, vx = 0;
  // 速さは直近 100ms の動きから測る（イベントの間隔がばらついても安定させるため）
  let samples: { x: number; t: number }[] = [];
  let mode: 'idle' | 'pending' | 'drag' = 'idle';
  let crossed = false;
  let pid = -1;

  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.desk')) return;
    mode = 'pending';
    pid = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    samples = [{ x: e.clientX, t: e.timeStamp }];
    dx = vx = 0;
    crossed = false;
  });

  card.addEventListener('pointermove', (e) => {
    if (mode === 'idle' || e.pointerId !== pid) return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;
    if (mode === 'pending') {
      if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) return void (mode = 'idle');
      if (Math.abs(mx) < 8) return;
      mode = 'drag';
      try {
        card.setPointerCapture(pid);
      } catch {
        /* すでに離された指など。掴めなくても動かすことはできる */
      }
      row.classList.add('dragging', 'swiping');
    }
    samples.push({ x: e.clientX, t: e.timeStamp });
    while (samples.length > 2 && e.timeStamp - samples[0].t > 100) samples.shift();
    vx = (e.clientX - samples[0].x) / Math.max(1, e.timeStamp - samples[0].t);

    const dir = mx >= 0 ? 1 : -1;
    const target = swipeTarget(store.get(id)!.status, dir);
    const w = row.offsetWidth;
    // 行き先がない方向や、しきい値を超えた先はゴムのように重くする
    dx = target ? mx : mx * 0.25;
    if (target && Math.abs(mx) > w * 0.6) dx = dir * (w * 0.6 + (Math.abs(mx) - w * 0.6) * 0.3);
    const on = !!target && Math.abs(dx) > w * 0.32;
    if (on !== crossed) {
      crossed = on;
      if (on) haptic();
    }
    paintBg(dir, target, on);
    card.style.transform = `translateX(${dx}px) rotate(${dx / w * 3}deg)`;
  });

  const end = (e: PointerEvent) => {
    if (e.pointerId !== pid) return;
    const wasDrag = mode === 'drag';
    mode = 'idle';
    if (!wasDrag) return;
    row.classList.remove('dragging');
    const dir = dx >= 0 ? 1 : -1;
    const target = swipeTarget(store.get(id)!.status, dir);
    const flick = Math.abs(vx) > 0.4 && Math.sign(vx) === dir && Math.abs(dx) > 30;
    if (target && e.type !== 'pointercancel' && (crossed || flick)) {
      card.style.transform = '';
      card.animate(
        [{ transform: `translateX(${dx}px) rotate(${dx / row.offsetWidth * 3}deg)` }, { transform: `translateX(${dir * 115}%) rotate(${dir * 5}deg)` }],
        { duration: Math.max(140, 320 - Math.abs(vx) * 90), easing: 'cubic-bezier(0.3, 0, 0.6, 1)', fill: 'forwards' }
      ).finished.then(() => applyMove(id, target, row));
    } else {
      // 元に戻す（ばねのように少し行き過ぎて止まる）
      const from = card.style.transform;
      card.style.transform = '';
      card.animate([{ transform: from }, { transform: 'none' }], { duration: 520, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' })
        .finished.then(() => row.classList.remove('swiping'));
    }
    // ドラッグ直後のクリックで編集が開かないようにする
    card.addEventListener('click', (ev) => ev.stopImmediatePropagation(), { once: true, capture: true });
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
  card.addEventListener('click', () => openEditor(id));
}

// ---------- シート（編集・アカウント） ----------

const sheet = $('#sheet');
const scrim = $('#scrim');
const sheetBody = $('#sheetBody');
let onSheetClose: (() => void) | null = null;

function openSheet(html: string, onClose?: () => void) {
  sheetBody.innerHTML = html;
  onSheetClose = onClose ?? null;
  sheet.classList.remove('out');
  scrim.classList.remove('out');
  sheet.hidden = scrim.hidden = false;
}
function closeSheet() {
  if (sheet.hidden) return;
  onSheetClose?.();
  onSheetClose = null;
  sheet.classList.add('out');
  scrim.classList.add('out');
  setTimeout(() => (sheet.hidden = scrim.hidden = true), reduceMotion ? 0 : 280);
}
scrim.addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeSheet());

// シートを下に引っぱって閉じる
{
  let y0 = 0, dy = 0, on = false;
  sheet.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('textarea,button,a')) return;
    on = true;
    y0 = e.clientY;
    dy = 0;
    sheet.setPointerCapture(e.pointerId);
  });
  sheet.addEventListener('pointermove', (e) => {
    if (!on) return;
    dy = Math.max(0, e.clientY - y0);
    sheet.style.translate = `0 ${dy}px`;
  });
  const up = () => {
    if (!on) return;
    on = false;
    sheet.style.translate = '';
    if (dy > 90) closeSheet();
  };
  sheet.addEventListener('pointerup', up);
  sheet.addEventListener('pointercancel', up);
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function openEditor(id: string) {
  const t = store.get(id);
  if (!t) return;
  let status = t.status;
  openSheet(
    `<h2>編集</h2>
     <textarea id="editTitle" aria-label="タスク名">${esc(t.title)}</textarea>
     <div class="seg">${VIEWS.map((s) => `<button type="button" data-s="${s}" aria-pressed="${s === t.status}">${LABEL[s]}</button>`).join('')}</div>
     <div class="btn-row">
       <button type="button" class="btn btn-danger" id="editDelete">${ICON.trash.replace('<svg', '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"')}削除</button>
       <button type="button" class="btn btn-primary" id="editDone">保存</button>
     </div>`,
    () => {
      const title = $<HTMLTextAreaElement>('#editTitle').value.trim();
      const cur = store.get(id);
      if (!cur || cur.deleted) return;
      if (title && (title !== cur.title || status !== cur.status)) {
        store.update(id, { title, ...(status !== cur.status ? { status, position: store.maxPosition(status) + 1 } : {}) });
        render();
        scheduleSync();
      }
    }
  );
  sheetBody.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) =>
    b.addEventListener('click', () => {
      status = b.dataset.s as Status;
      sheetBody.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      haptic();
    })
  );
  $('#editDone').addEventListener('click', closeSheet);
  $('#editDelete').addEventListener('click', () => {
    onSheetClose = null;
    closeSheet();
    applyMove(id, 'delete', rows.get(id));
  });
}

function openAccount(note?: string) {
  const u = store.user;
  if (!u) {
    openSheet(
      `<h2>ログイン</h2>
       ${note ? `<p class="sync-state pending">${esc(note)}</p>` : ''}
       <a class="btn btn-google" id="googleLogin" href="/auth/google">${ICON.google}Google でログイン</a>`
    );
    return;
  }
  const pending = store.dirtyCount();
  openSheet(
    `<div class="profile">
       <span class="glass avatar">${avatarHtml(u)}</span>
       <div><div class="name">${esc(u.name || u.email)}</div><div class="mail">${esc(u.email)}</div></div>
     </div>
     <p class="sync-state ${pending ? 'pending' : ''}" id="syncState">${pending ? `同期待ち ${pending}件` : '同期済み'}</p>
     <div class="btn-row"><button type="button" class="btn btn-plain" id="logoutBtn">ログアウト</button></div>`
  );
  $('#logoutBtn').addEventListener('click', async () => {
    await syncNow().catch(() => {});
    await api.logout().catch(() => {});
    store.reset();
    closeSheet();
    renderAccount();
    for (const el of rows.values()) el.remove();
    rows.clear();
    render();
    toast('ログアウトしました');
  });
}

function avatarHtml(u: { name: string; email: string; picture: string }) {
  if (u.picture) return `<img src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer">`;
  return `<span class="initial">${esc((u.name || u.email).slice(0, 1).toUpperCase())}</span>`;
}

function renderAccount() {
  const btn = $('#accountBtn');
  btn.innerHTML = store.user ? avatarHtml(store.user) : ICON.person;
  btn.setAttribute('aria-label', store.user ? 'アカウント' : 'ログイン');
}
$('#accountBtn').addEventListener('click', () => openAccount());

// ---------- トースト ----------

const toastEl = $('#toast');
let toastTimer = 0;
function toast(msg: string, undo?: () => void) {
  toastEl.innerHTML = `<span class="msg">${esc(msg)}</span>${undo ? '<button type="button">取り消す</button>' : ''}`;
  if (undo)
    toastEl.querySelector('button')!.addEventListener('click', () => {
      undo();
      hide();
    });
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  const hide = () => toastEl.classList.remove('show');
  toastTimer = window.setTimeout(hide, undo ? 4000 : 2400);
}

// ---------- 同期 ----------

let syncTimer = 0;
let syncing: Promise<void> | null = null;
function scheduleSync(delay = 600) {
  if (!store.user) return;
  clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => syncNow().catch(() => {}), delay);
}
async function syncNow(): Promise<void> {
  if (!store.user) return;
  if (syncing) {
    await syncing;
    return syncNow();
  }
  syncing = (async () => {
    const sent = store.dirtyTasks();
    try {
      const res = await api.sync(store.cursor, sent);
      const changed = store.applyServer(res.tasks, sent, res.now);
      if (changed && ready) render();
      const st = document.getElementById('syncState');
      if (st) {
        const n = store.dirtyCount();
        st.textContent = n ? `同期待ち ${n}件` : '同期済み';
        st.classList.toggle('pending', n > 0);
      }
    } catch (err) {
      if (err instanceof Unauthorized) onUnauthorized();
      throw err;
    }
  })().finally(() => (syncing = null));
  return syncing;
}
function onUnauthorized() {
  store.setUser(null);
  renderAccount();
}
addEventListener('online', () => scheduleSync(0));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleSync(0);
  else if (store.dirtyCount()) syncNow().catch(() => {});
});
// 別タブでの変更を反映
addEventListener('storage', (e) => {
  if (e.key === store.KEY) {
    store.load();
    render();
  }
});

// ---------- 起動 ----------

function reveal() {
  if (ready) return;
  ready = true;
  const sk = list.querySelector('.skeleton-list');
  const done = () => {
    sk?.remove();
    document.body.classList.remove('loading');
    renderAccount();
    $('#viewTitle').innerHTML = `<span class="t">${LABEL[view]}</span>`;
    render({ stagger: true });
  };
  if (sk && !reduceMotion) {
    sk.classList.add('out');
    setTimeout(done, 200);
  } else done();
}

async function boot() {
  const login = new URLSearchParams(location.search).get('login');
  if (login) history.replaceState(null, '', '/');
  // 画面を描く前に読む必要があるのは /api/me だけ。遅いときは 2.5 秒で諦めて手元のデータで開く
  const timeout = setTimeout(reveal, 2500);
  try {
    const me = await api.me();
    if (store.user && store.user.id !== me.id) store.reset();
    store.setUser(me);
    await syncNow().catch(() => {});
  } catch (err) {
    if (err instanceof Unauthorized) store.setUser(null);
  } finally {
    clearTimeout(timeout);
    reveal();
    if (login === 'failed') toast('ログインできませんでした');
  }
}

// スケルトン中にメモを追加しても、すぐ一覧が見えるようにする
composer.addEventListener('submit', () => reveal(), { capture: true });

boot();

if ('serviceWorker' in navigator && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
