import { test, expect, type Page, type Locator } from '@playwright/test';

// ---------- 操作の補助 ----------

const rows = (page: Page) => page.locator('#list .row');
const row = (page: Page, title: string) => page.locator('#list .row', { hasText: title });

async function add(page: Page, ...titles: string[]) {
  for (const t of titles) {
    await page.fill('#memo', t);
    await page.keyboard.press('Enter');
    await expect(row(page, t)).toBeVisible();
  }
}

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.locator('body')).not.toHaveClass(/loading/);
}

/** 実際の指の動き（タッチ）でフリックする。PC ではマウスでドラッグ */
/** 追加・並び替えのアニメーションが終わるまで待つ（動いている途中の行を掴まないため） */
async function settle(page: Page) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((a) => a.effect?.getTiming().iterations === Infinity || a.playState !== 'running')
  );
}

async function swipe(page: Page, target: Locator, dx: number, opts: { steps?: number } = {}) {
  const steps = opts.steps ?? 8;
  await settle(page);
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    const point = (px: number) => [{ x: px, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(x) });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x + (dx * i) / steps) });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(x + (dx * i) / steps, y);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  }
}

async function tab(page: Page, view: 'todo' | 'doing' | 'done') {
  await page.click(`.tab[data-view="${view}"]`);
  await expect(page.locator(`.tab[data-view="${view}"]`)).toHaveAttribute('aria-selected', 'true');
}

const count = (page: Page, view: string) => page.locator(`.tab[data-view="${view}"] .count`);

async function devLogin(page: Page, sub: string) {
  await page.goto(`/auth/dev-login?sub=${sub}`);
  await expect(page.locator('body')).not.toHaveClass(/loading/);
  await expect(page.locator('#accountBtn')).toHaveAttribute('aria-label', 'アカウント');
}

const uid = () => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// 想定外のエラーがコンソールに出ていないことを全テストで確かめる
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // 未ログイン時の 401 と、わざと送る不正リクエストの 400 は仕様どおり
    if (m.type() === 'error' && !/status of (401|400)/.test(m.text())) errors.push(m.text());
  });
  (page as any).__errors = errors;
});
test.afterEach(async ({ page }) => {
  expect((page as any).__errors, 'コンソールエラー').toEqual([]);
});

// ---------- 開いた瞬間メモ ----------

test.describe('開いた瞬間メモ', () => {
  test('読み込み完了を待たずにメモ欄へ入力でき、追加もできる', async ({ page }) => {
    // サーバー応答をわざと 3 秒遅らせる
    await page.route('**/api/me', async (r) => {
      await new Promise((res) => setTimeout(res, 3000));
      await r.continue();
    });
    const t0 = Date.now();
    await page.goto('/', { waitUntil: 'commit' });
    await expect(page.locator('#memo')).toBeFocused();
    await page.keyboard.type('すぐ書けるメモ');
    await expect(page.locator('#memo')).toHaveValue('すぐ書けるメモ');
    await expect(page.locator('body')).toHaveClass(/loading/); // まだ読み込み中
    await page.keyboard.press('Enter');
    await expect(row(page, 'すぐ書けるメモ')).toBeVisible();
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test('書きかけのメモは閉じても残る', async ({ page }) => {
    await ready(page);
    await page.fill('#memo', '書きかけ');
    await page.reload();
    await expect(page.locator('#memo')).toHaveValue('書きかけ');
  });

  test('空のときは追加ボタンが押せない／Shift+Enter で改行できる', async ({ page }) => {
    await ready(page);
    await expect(page.locator('#addBtn')).toBeDisabled();
    await page.locator('#memo').pressSequentially('1行目');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('2行目');
    await expect(page.locator('#memo')).toHaveValue('1行目\n2行目');
    await page.click('#addBtn');
    await expect(rows(page)).toHaveCount(1);
    await expect(page.locator('#memo')).toHaveValue('');
    await expect(page.locator('#memo')).toBeFocused();
  });

  test('追加したタスクは再読み込みしても残り、新しい順に並ぶ', async ({ page }) => {
    await ready(page);
    await add(page, 'A', 'B', 'C');
    await page.reload();
    await expect(rows(page).locator('.title')).toHaveText(['C', 'B', 'A']);
    await expect(count(page, 'todo')).toHaveText('3');
  });
});

// ---------- スケルトン ----------

test('全画面スケルトンを表示し、読み込み後に消える', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route('**/api/me', async (r) => {
    await gate;
    await r.continue();
  });
  await page.goto('/', { waitUntil: 'commit' });
  await expect(page.locator('body')).toHaveClass(/loading/);
  await expect(page.locator('.skeleton-list .sk-row')).toHaveCount(6);
  await expect(page.locator('#viewTitle .sk')).toBeVisible();
  await expect(page.locator('#accountBtn .sk')).toBeVisible();
  await expect(page.locator('.tab .count .sk')).toHaveCount(3);
  release();
  await expect(page.locator('body')).not.toHaveClass(/loading/);
  await expect(page.locator('.skeleton-list')).toHaveCount(0);
  await expect(page.locator('.sk')).toHaveCount(0);
  await expect(page.locator('#viewTitle')).toHaveText('未着手');
});

// ---------- フリックでステータス管理 ----------

test.describe('フリック', () => {
  test('右にフリックで 未着手→進行中→完了、左で戻す', async ({ page }) => {
    await ready(page);
    await add(page, '資料を作る');
    const w = (await rows(page).first().boundingBox())!.width;

    await swipe(page, row(page, '資料を作る').locator('.card'), w * 0.6);
    await expect(rows(page)).toHaveCount(0);
    await expect(count(page, 'todo')).toHaveText('0');
    await expect(count(page, 'doing')).toHaveText('1');

    await tab(page, 'doing');
    await swipe(page, row(page, '資料を作る').locator('.card'), w * 0.6);
    await expect(count(page, 'done')).toHaveText('1');

    await tab(page, 'done');
    await expect(row(page, '資料を作る')).toHaveAttribute('data-status', 'done');
    await swipe(page, row(page, '資料を作る').locator('.card'), -w * 0.6);
    await expect(count(page, 'doing')).toHaveText('1');
    await expect(count(page, 'done')).toHaveText('0');
  });

  test('短くても速いフリックなら移動する', async ({ page }) => {
    await ready(page);
    await add(page, '速いフリック');
    // 指で「ピッ」と弾く速さ（約 50ms で 90px）を正確に再現するため、イベントを時間どおりに送る
    await settle(page);
    await row(page, '速いフリック').locator('.card').evaluate((card, dx) => {
      const r = card.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const ev = (type: string, px: number) =>
        card.dispatchEvent(
          new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: px, clientY: y, button: 0 })
        );
      ev('pointerdown', x);
      for (let i = 1; i <= 5; i++) {
        // 10ms 間隔（テスト機の負荷でタイマーが遅れないよう、待ちはその場で回す）
        const t = performance.now();
        while (performance.now() - t < 10);
        ev('pointermove', x + (dx * i) / 5);
      }
      ev('pointerup', x + dx);
    }, 90);
    await expect(count(page, 'doing')).toHaveText('1');
  });

  test('ゆっくり少しだけ動かしたら元に戻る', async ({ page }) => {
    await ready(page);
    await add(page, '戻るはず');
    await swipe(page, row(page, '戻るはず').locator('.card'), 60, { steps: 20 });
    await page.waitForTimeout(700);
    await expect(row(page, '戻るはず')).toBeVisible();
    await expect(count(page, 'doing')).toHaveText('0');
    await expect(row(page, '戻るはず').locator('.card')).toHaveCSS('transform', 'none');
    // 動かしただけで編集シートが開かない
    await expect(page.locator('#sheet')).toBeHidden();
  });

  test('未着手で左にフリックすると削除、「取り消す」で元に戻る', async ({ page }) => {
    await ready(page);
    await add(page, '消すもの', '残すもの');
    const w = (await rows(page).first().boundingBox())!.width;
    await swipe(page, row(page, '消すもの').locator('.card'), -w * 0.6);
    await expect(row(page, '消すもの')).toHaveCount(0);
    await expect(page.locator('#toast')).toContainText('削除しました');
    await page.locator('#toast button').click();
    await expect(row(page, '消すもの')).toBeVisible();
    await expect(count(page, 'todo')).toHaveText('2');
  });

  test('スワイプ中は行き先の色とラベルが出る', async ({ page }) => {
    await ready(page);
    await add(page, '色を確認');
    const card = row(page, '色を確認').locator('.card');
    const box = (await card.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2, { steps: 8 });
    await expect(row(page, '色を確認')).toHaveClass(/swiping/);
    await expect(row(page, '色を確認').locator('.hint.r')).toHaveText('進行中');
    await expect(row(page, '色を確認').locator('.row-bg')).toHaveCSS('background-color', 'rgb(255, 149, 0)');
    // 動かしている最中も横に広がらず、タブバーの位置が変わらない
    const m = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
      tab: document.querySelector('#tabs')!.getBoundingClientRect().bottom,
      ih: innerHeight,
    }));
    expect(m.sw).toBeLessThanOrEqual(m.cw);
    expect(m.tab).toBeLessThanOrEqual(m.ih);
    await page.mouse.up();
    await expect(page.locator('#tabs')).toBeInViewport({ ratio: 1 });
  });

  test('丸ボタンで完了／完了から未着手に戻す', async ({ page }) => {
    await ready(page);
    await add(page, 'チェック');
    await row(page, 'チェック').locator('.check').click();
    await expect(count(page, 'done')).toHaveText('1');
    await tab(page, 'done');
    await row(page, 'チェック').locator('.check').click();
    await expect(count(page, 'todo')).toHaveText('1');
  });
});

// ---------- タブ・編集 ----------

test('タブで切り替えると、その状態のタスクだけ表示される', async ({ page }) => {
  await ready(page);
  await add(page, '一', '二', '三');
  await row(page, '二').locator('.check').click();
  await expect(count(page, 'done')).toHaveText('1');
  await tab(page, 'done');
  await expect(page.locator('#viewTitle')).toHaveText('完了');
  await expect(rows(page).locator('.title')).toHaveText(['二']);
  await tab(page, 'doing');
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator('.empty')).toBeVisible();
  await tab(page, 'todo');
  await expect(rows(page).locator('.title')).toHaveText(['三', '一']);
});

test('タップで編集シートが開き、名前と状態を変えられる', async ({ page }) => {
  await ready(page);
  await add(page, '編集前');
  await row(page, '編集前').locator('.title').click();
  await expect(page.locator('#sheet')).toBeVisible();
  await page.fill('#editTitle', '編集後');
  await page.click('.seg button[data-s="doing"]');
  await page.click('#editDone');
  await expect(page.locator('#sheet')).toBeHidden();
  await expect(count(page, 'doing')).toHaveText('1');
  await tab(page, 'doing');
  await expect(row(page, '編集後')).toBeVisible();
});

test('メモ追加中に別タブを見ていたら未着手に戻る', async ({ page }) => {
  await ready(page);
  await tab(page, 'done');
  await add(page, '新規');
  await expect(page.locator('.tab[data-view="todo"]')).toHaveAttribute('aria-selected', 'true');
});

// ---------- PC 操作 ----------

test.describe('PC', () => {
  test.skip(({ isMobile }) => isMobile, 'PC のみ');

  test('ホバーで出る矢印ボタンとキーボードで状態を動かせる', async ({ page }) => {
    await ready(page);
    await add(page, 'キーボード');
    const r = row(page, 'キーボード');
    await r.hover();
    await expect(r.locator('.next')).toBeVisible();
    await r.locator('.next').click();
    await expect(count(page, 'doing')).toHaveText('1');
    await tab(page, 'doing');
    await row(page, 'キーボード').locator('.card').focus();
    await page.keyboard.press('ArrowRight');
    await expect(count(page, 'done')).toHaveText('1');
  });
});

// ---------- ログイン・同期 ----------

test.describe('ログインと同期', () => {
  test('未ログインのアカウント画面には Google ログインだけがある', async ({ page }) => {
    await ready(page);
    await page.click('#accountBtn');
    await expect(page.locator('#sheet')).toBeVisible();
    const links = page.locator('#sheet a, #sheet button');
    await expect(links).toHaveCount(1);
    await expect(page.locator('#googleLogin')).toHaveAttribute('href', '/auth/google');
    await expect(page.locator('#googleLogin')).toContainText('Google');
  });

  test('Google 認証へ PKCE 付きでリダイレクトする', async ({ request }) => {
    const res = await request.get('/auth/google', { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    const loc = new URL(res.headers()['location']);
    expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(loc.searchParams.get('client_id')).toBe('e2e-dummy.apps.googleusercontent.com');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('scope')).toBe('openid email profile');
    expect(loc.searchParams.get('redirect_uri')).toMatch(/\/auth\/google\/callback$/);
    expect(res.headers()['set-cookie']).toContain('__Host-oauth_state=');
  });

  test('state が合わないコールバックはログイン失敗になる', async ({ page }) => {
    await page.goto('/auth/google/callback?code=x&state=forged');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('#toast')).toContainText('ログインできませんでした');
    await expect(page.locator('#accountBtn')).toHaveAttribute('aria-label', 'ログイン');
  });

  test('ログイン前のメモもログイン後にサーバーへ同期され、別の端末で見える', async ({ page, browser }) => {
    const sub = uid();
    await ready(page);
    await add(page, 'ログイン前のメモ');
    await devLogin(page, sub);
    await add(page, 'ログイン後のメモ');
    await swipe(page, row(page, 'ログイン後のメモ').locator('.card'), 300);
    await expect(count(page, 'doing')).toHaveText('1');
    // 同期待ちが無くなるまで待つ
    await page.click('#accountBtn');
    await expect(page.locator('#syncState')).toHaveText('同期済み');

    // まっさらな別の端末
    const other = await browser.newContext();
    const p2 = await other.newPage();
    await devLogin(p2, sub);
    await expect(row(p2, 'ログイン前のメモ')).toBeVisible();
    await expect(count(p2, 'doing')).toHaveText('1');
    await tab(p2, 'doing');
    await expect(row(p2, 'ログイン後のメモ')).toBeVisible();

    // 別端末での削除がこちらにも届く
    await swipe(p2, row(p2, 'ログイン後のメモ').locator('.card'), -300);
    await tab(p2, 'todo');
    await swipe(p2, row(p2, 'ログイン後のメモ').locator('.card'), -300);
    await expect(count(p2, 'todo')).toHaveText('1');
    await p2.click('#accountBtn');
    await expect(p2.locator('#syncState')).toHaveText('同期済み');
    await other.close();

    await page.reload();
    await expect(page.locator('body')).not.toHaveClass(/loading/);
    await expect(row(page, 'ログイン後のメモ')).toHaveCount(0);
    await expect(count(page, 'todo')).toHaveText('1');
    await expect(count(page, 'doing')).toHaveText('0');
  });

  test('ログアウトすると端末のデータが消える', async ({ page }) => {
    await devLogin(page, uid());
    await add(page, '個人的なタスク');
    await page.click('#accountBtn');
    await page.click('#logoutBtn');
    await expect(page.locator('#accountBtn')).toHaveAttribute('aria-label', 'ログイン');
    await expect(rows(page)).toHaveCount(0);
    await page.reload();
    await expect(page.locator('body')).not.toHaveClass(/loading/);
    await expect(rows(page)).toHaveCount(0);
  });
});

// ---------- AI ----------

test.describe('AI（Workers AI）', () => {
  test('未ログインで押すとログインを求める', async ({ page }) => {
    await ready(page);
    await page.fill('#memo', '牛乳を買う\n歯医者を予約');
    await page.click('#aiBtn');
    await expect(page.locator('#googleLogin')).toBeVisible();
    await expect(page.locator('#memo')).toHaveValue('牛乳を買う\n歯医者を予約');
  });

  test('メモを複数のタスクに分けて追加する', async ({ page }) => {
    await devLogin(page, uid());
    await page.fill('#memo', '牛乳を買う\n・歯医者を予約する\n1. 請求書を送る');
    await page.click('#aiBtn');
    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).locator('.title')).toHaveText(['牛乳を買う', '歯医者を予約する', '請求書を送る']);
    await expect(page.locator('#memo')).toHaveValue('');
    await expect(page.locator('#toast')).toContainText('3件');
  });
});

// ---------- API の安全性 ----------

test.describe('API', () => {
  test('未ログインでは 401', async ({ request }) => {
    expect((await request.get('/api/me')).status()).toBe(401);
    const r = await request.post('/api/sync', { headers: { 'x-ft': '1' }, data: { since: 0, changes: [] } });
    expect(r.status()).toBe(401);
  });

  test('CSRF 用ヘッダーのない変更リクエストは拒否', async ({ page }) => {
    await devLogin(page, uid());
    const status = await page.evaluate(async () => {
      const r = await fetch('/api/sync', { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } });
      return r.status;
    });
    expect(status).toBe(400);
  });

  test('他人のタスクは見えない', async ({ browser }) => {
    const a = await browser.newContext();
    const pa = await a.newPage();
    await devLogin(pa, uid());
    await add(pa, 'Aさんの秘密');
    await pa.click('#accountBtn');
    await expect(pa.locator('#syncState')).toHaveText('同期済み');
    const b = await browser.newContext();
    const pb = await b.newPage();
    await devLogin(pb, uid());
    await expect(rows(pb)).toHaveCount(0);
    await a.close();
    await b.close();
  });
});

// ---------- レイアウト ----------

test('横スクロールが出ず、タブバーが画面内に収まる', async ({ page }) => {
  await ready(page);
  await add(page, 'とても長いタスク名'.repeat(12));
  const m = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(m.sw).toBeLessThanOrEqual(m.cw);
  const bar = (await page.locator('#tabs').boundingBox())!;
  const vp = page.viewportSize()!;
  expect(bar.x).toBeGreaterThanOrEqual(0);
  expect(bar.x + bar.width).toBeLessThanOrEqual(vp.width);
  expect(bar.y + bar.height).toBeLessThanOrEqual(vp.height);
  // 指で押しやすい大きさ（44pt 以上）
  for (const sel of ['#addBtn', '#accountBtn', '.tab']) {
    const b = (await page.locator(sel).first().boundingBox())!;
    expect(Math.min(b.width, b.height), sel).toBeGreaterThanOrEqual(44);
  }
});

test('ガラスの質感（背景ぼかし）が効いている', async ({ page }) => {
  await ready(page);
  const f = await page.locator('#tabs').evaluate((el) => getComputedStyle(el).backdropFilter);
  expect(f).toContain('blur');
});
