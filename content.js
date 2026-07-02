// content.js — ページ上の書き込み本体
// ドキュメント全体を覆う透明 SVG オーバーレイに描画する。
// オーバーレイは position:absolute なのでスクロールしても書き込みは
// ドキュメント座標に固定され、内容と一緒に追従する。
//
// 表示状態・モード・ツール・色・位置は chrome.storage.local に保存し、
// storage.onChanged で全タブが同期する。これにより、タブ切替でページが
// 自動破棄→再読み込みされてもパレットが復元され、消えなくなる。
(() => {
  "use strict";

  // 二重注入ガード（SPA で再実行されても 1 セットだけ）
  if (window.__pageAnnotatorLoaded) {
    return;
  }
  window.__pageAnnotatorLoaded = true;

  const SVG_NS = "http://www.w3.org/2000/svg";
  const Z = 2147483640; // 可能な限り手前へ

  // ---- 設定値 ----
  const PEN_COLORS = [
    { name: "赤", value: "#e53935" },
    { name: "黒", value: "#000000" },
    { name: "青", value: "#1e88e5" },
    { name: "緑", value: "#43a047" },
  ];
  const HL_COLORS = [
    { name: "黄", value: "#ffeb3b" },
    { name: "橙", value: "#ff9800" },
    { name: "赤", value: "#ff5252" },
    { name: "青", value: "#40c4ff" },
  ];
  const PEN_WIDTH = 3;
  const HL_WIDTH = 16;
  const SHAPE_WIDTH = 3;
  const ERASER_RADIUS = 10; // 消しゴムの当たり判定半径(px)
  const DBLCLICK_MS = 450; // 右ダブルクリック判定のしきい値
  const LASER_WIDTH = 5; // レーザーの線の太さ
  const LASER_DOT_R = 9; // レーザーのカーソルドット半径
  const LASER_OPACITY = 0.55; // レーザーの半透明度
  const FADE_OPTIONS = [1, 3, 5, 10]; // レーザー残存秒数の選択肢

  // ---- 永続状態（chrome.storage.local に保存する内容）----
  const DEFAULTS = {
    visible: false, // パレット表示中か
    enabled: true, // 描画モードON（false=マウスモード）
    tool: "pen", // pen | highlighter | line | arrow | circle | laser | eraser
    writeTool: "pen", // 直前に使った「書き込み系」ツール（laser 以外）。Wクリック巡回で復元する
    penColor: PEN_COLORS[0].value,
    hlColor: HL_COLORS[0].value,
    toggleClick: "right", // モード切替の操作: "right"=右ダブルクリック / "left"=左ダブルクリック
    // ダブルクリック巡回に含める状態（チェックを外した状態は巡回でスキップされる）
    // マウスは常に含むため対象外
    cycleStates: { pen: true, highlighter: true, laser: true, eraser: true },
    fadeSec: 3, // レーザーの書き込みが残る秒数（1/3/5/10）
    palette: "full", // パレット表示: "full"=詳細 / "simple"=簡単
    // ツールバー位置（ドラッグ移動後）はビューポートに対する割合(0〜1)で保持。
    // こうするとページを拡大縮小してビューポートの論理サイズが変わっても、
    // パレットは画面上の同じ相対位置（右上なら右上）に留まる。
    leftFrac: null,
    topFrac: null,
  };

  // ダブルクリック / モードボタンで巡回しうる5状態と表示メタ情報
  const CYCLE = ["pen", "highlighter", "laser", "eraser", "mouse"];
  const MODE_META = {
    pen: { icon: "✏️", name: "ペン" },
    highlighter: { icon: "🖍", name: "蛍光" },
    laser: { icon: "🔴", name: "レーザー" },
    eraser: { icon: "⌫", name: "消し" },
    mouse: { icon: "🖱", name: "マウス" },
    line: { icon: "／", name: "直線" },
    arrow: { icon: "↗", name: "矢印" },
    circle: { icon: "○", name: "円" },
  };
  // チェックされていて巡回対象になっている状態か
  function isCycleEnabled(k) {
    if (k === "mouse") return true; // マウスは常に巡回に含める（UIでの切替対象外）
    const cs = stored.cycleStates || {};
    return cs[k] !== false; // 既定（未指定）は有効
  }
  // 巡回が機能するには2状態以上の有効が必要
  function cycleActive() {
    return CYCLE.filter(isCycleEnabled).length >= 2;
  }
  // 現在の状態から見て、巡回順で次に有効な状態を返す
  function nextModeKey(key) {
    let idx = CYCLE.indexOf(key);
    if (idx < 0) idx = CYCLE.indexOf("pen"); // 図形ツールなどはペン位置とみなす
    for (let i = 1; i <= CYCLE.length; i++) {
      const cand = CYCLE[(idx + i) % CYCLE.length];
      if (isCycleEnabled(cand)) return cand;
    }
    return key; // 有効状態が現在のものしかなければ据え置き
  }
  let stored = Object.assign({}, DEFAULTS);

  // ---- ページズーム補正 ----
  // ブラウザのページズーム（Ctrl +/-）では position:fixed のツールバーも
  // 一緒に拡大・縮小されてしまう。読み込み時のズーム倍率を基準に、その後の
  // 変化分だけツールバーへ逆向きの CSS zoom を当て、見かけのサイズを固定する。
  // window.devicePixelRatio はページズームに連動して変化する性質を利用する。
  const BASE_DPR = window.devicePixelRatio || 1;
  let zoomScale = 1;

  // ---- 一時的な描画状態（永続化しない）----
  const state = {
    enabled: false, // 実際にオーバーレイがポインタを受けているか
    tool: "pen",
    penColor: PEN_COLORS[0].value,
    hlColor: HL_COLORS[0].value,
    drawing: false,
    current: null,
    points: [],
    undoStack: [],
  };

  // =========================================================
  // オーバーレイ SVG
  // =========================================================
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("id", "pa-overlay");
  svg.style.position = "absolute";
  svg.style.top = "0";
  svg.style.left = "0";
  svg.style.margin = "0";
  svg.style.padding = "0";
  svg.style.border = "none";
  svg.style.zIndex = String(Z - 1);
  svg.style.pointerEvents = "none";
  svg.style.overflow = "visible";
  svg.style.background = "transparent";

  const defs = document.createElementNS(SVG_NS, "defs");
  defs.innerHTML =
    '<marker id="pa-arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">' +
    '<path d="M0,0 L8,3 L0,6 Z" fill="context-stroke"></path>' +
    "</marker>";
  svg.appendChild(defs);

  // カーソルプレビュー（追従ドット。pointer-events なし）
  // ツールごとに「これから書き込む色・太さ」が分かるよう見た目を変える。
  // ペン/蛍光=その色の丸、レーザー=半透明の丸、消し=中空の黒い丸。
  const cursorDot = document.createElementNS(SVG_NS, "circle");
  cursorDot.setAttribute("r", LASER_DOT_R);
  cursorDot.setAttribute("fill", PEN_COLORS[0].value);
  cursorDot.style.pointerEvents = "none";
  cursorDot.style.display = "none";
  svg.appendChild(cursorDot);

  // 現在のツールに合わせてカーソルドットを更新・表示する
  function updateCursor(pt) {
    const t = state.tool;
    let r, fill, stroke = "none", sw = 0, opacity;
    if (t === "pen") {
      r = 5; fill = state.penColor; opacity = 0.9;
    } else if (t === "highlighter") {
      r = HL_WIDTH / 2; fill = state.hlColor; opacity = 0.5;
    } else if (t === "laser") {
      r = LASER_DOT_R; fill = state.penColor; opacity = LASER_OPACITY;
    } else if (t === "eraser") {
      r = ERASER_RADIUS; fill = "none"; stroke = "#000"; sw = 2; opacity = 0.85;
    } else {
      hideCursor(); // 直線/矢印/マウスはプレビューなし
      return;
    }
    cursorDot.setAttribute("cx", pt.x);
    cursorDot.setAttribute("cy", pt.y);
    cursorDot.setAttribute("r", r);
    cursorDot.setAttribute("fill", fill);
    cursorDot.setAttribute("stroke", stroke);
    cursorDot.setAttribute("stroke-width", sw);
    cursorDot.setAttribute("opacity", String(opacity));
    cursorDot.style.display = "block";
  }
  function hideCursor() {
    cursorDot.style.display = "none";
  }

  function attachOverlay() {
    const parent = document.body || document.documentElement;
    if (parent && svg.parentNode !== parent) {
      parent.appendChild(svg);
    }
  }
  attachOverlay();

  function docSize() {
    const d = document.documentElement;
    const b = document.body || d;
    return {
      w: Math.max(d.scrollWidth, b.scrollWidth, d.clientWidth),
      h: Math.max(d.scrollHeight, b.scrollHeight, d.clientHeight),
    };
  }
  function updateOverlaySize() {
    const { w, h } = docSize();
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);
    svg.style.width = w + "px";
    svg.style.height = h + "px";
  }
  updateOverlaySize();

  window.addEventListener("resize", updateOverlaySize, { passive: true });
  const ro = new ResizeObserver(() => updateOverlaySize());
  if (document.body) ro.observe(document.body);
  setInterval(updateOverlaySize, 1500);

  // =========================================================
  // 座標変換
  // =========================================================
  function toDocPoint(e) {
    return {
      x: e.pageX != null ? e.pageX : e.clientX + window.scrollX,
      y: e.pageY != null ? e.pageY : e.clientY + window.scrollY,
    };
  }

  // =========================================================
  // 描画ロジック
  // =========================================================
  function newPath(color, width, opacity, blend) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", color);
    p.setAttribute("stroke-width", width);
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    if (opacity != null) p.setAttribute("stroke-opacity", opacity);
    if (blend) p.style.mixBlendMode = blend;
    p.classList.add("pa-ink");
    return p;
  }

  function pointsToD(pts) {
    if (pts.length === 0) return "";
    let d = "M " + pts[0].x + " " + pts[0].y;
    for (let i = 1; i < pts.length; i++) {
      d += " L " + pts[i].x + " " + pts[i].y;
    }
    return d;
  }

  function startDraw(e) {
    const pt = toDocPoint(e);

    if (state.tool === "eraser") {
      state.drawing = true;
      eraseAt(pt);
      return;
    }

    state.drawing = true;
    state.points = [pt];

    if (state.tool === "pen") {
      state.current = newPath(state.penColor, PEN_WIDTH, 1, null);
      state.current.setAttribute("d", pointsToD(state.points));
    } else if (state.tool === "laser") {
      state.current = newPath(state.penColor, LASER_WIDTH, LASER_OPACITY, null);
      state.current.classList.remove("pa-ink"); // 一時的なので消去/全消去の対象外
      state.current.classList.add("pa-laser");
      state.current.setAttribute("d", pointsToD(state.points));
    } else if (state.tool === "highlighter") {
      state.current = newPath(state.hlColor, HL_WIDTH, 0.4, "multiply");
      state.current.setAttribute("d", pointsToD(state.points));
    } else if (state.tool === "line" || state.tool === "arrow") {
      const ln = document.createElementNS(SVG_NS, "line");
      ln.setAttribute("x1", pt.x);
      ln.setAttribute("y1", pt.y);
      ln.setAttribute("x2", pt.x);
      ln.setAttribute("y2", pt.y);
      ln.setAttribute("stroke", state.penColor);
      ln.setAttribute("stroke-width", SHAPE_WIDTH);
      ln.setAttribute("stroke-linecap", "round");
      ln.classList.add("pa-ink");
      if (state.tool === "arrow") {
        ln.setAttribute("marker-end", "url(#pa-arrowhead)");
      }
      state.current = ln;
    } else if (state.tool === "circle") {
      // 始点を一方の角、ドラッグ先を対角とする矩形に内接する楕円を描く
      const el = document.createElementNS(SVG_NS, "ellipse");
      el.setAttribute("cx", pt.x);
      el.setAttribute("cy", pt.y);
      el.setAttribute("rx", 0);
      el.setAttribute("ry", 0);
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", state.penColor);
      el.setAttribute("stroke-width", SHAPE_WIDTH);
      el.classList.add("pa-ink");
      state.current = el;
    }

    if (state.current) svg.appendChild(state.current);
  }

  function moveDraw(e) {
    if (!state.drawing) return;
    const pt = toDocPoint(e);

    if (state.tool === "eraser") {
      eraseAt(pt);
      return;
    }
    if (!state.current) return;

    if (state.tool === "pen" || state.tool === "highlighter" || state.tool === "laser") {
      state.points.push(pt);
      state.current.setAttribute("d", pointsToD(state.points));
    } else if (state.tool === "line" || state.tool === "arrow") {
      state.current.setAttribute("x2", pt.x);
      state.current.setAttribute("y2", pt.y);
    } else if (state.tool === "circle") {
      const s = state.points[0];
      state.current.setAttribute("cx", (s.x + pt.x) / 2);
      state.current.setAttribute("cy", (s.y + pt.y) / 2);
      state.current.setAttribute("rx", Math.abs(pt.x - s.x) / 2);
      state.current.setAttribute("ry", Math.abs(pt.y - s.y) / 2);
    }
  }

  function endDraw() {
    if (!state.drawing) return;
    state.drawing = false;

    if (state.tool === "eraser") {
      return;
    }

    if (state.tool === "laser") {
      if (state.current) {
        if (state.points.length === 1) {
          const p = state.points[0];
          state.current.setAttribute("d", "M " + p.x + " " + p.y + " L " + (p.x + 0.1) + " " + p.y);
        }
        scheduleLaserFade(state.current);
        state.current = null;
      }
      return;
    }

    if (state.current) {
      if (
        (state.tool === "pen" || state.tool === "highlighter") &&
        state.points.length === 1
      ) {
        const p = state.points[0];
        state.current.setAttribute("d", "M " + p.x + " " + p.y + " L " + (p.x + 0.1) + " " + p.y);
      }
      state.undoStack.push(state.current);
      state.current = null;
    }
  }

  // レーザーの書き込みを、選択秒数だけ残してからフェードアウトで消す
  function scheduleLaserFade(el) {
    const ms = (Number(stored.fadeSec) || 3) * 1000;
    setTimeout(() => {
      el.style.transition = "opacity 0.4s ease";
      el.style.opacity = "0";
      setTimeout(() => {
        if (el.parentNode) el.remove();
      }, 450);
    }, ms);
  }

  function eraseAt(pt) {
    const elems = Array.from(svg.querySelectorAll(".pa-ink"));
    for (const el of elems) {
      if (hitTest(el, pt)) {
        el.remove();
        const idx = state.undoStack.indexOf(el);
        if (idx >= 0) state.undoStack.splice(idx, 1);
      }
    }
  }

  function hitTest(el, pt) {
    try {
      if (typeof el.isPointInStroke === "function") {
        const sp = svg.createSVGPoint();
        const offsets = [
          [0, 0],
          [ERASER_RADIUS, 0],
          [-ERASER_RADIUS, 0],
          [0, ERASER_RADIUS],
          [0, -ERASER_RADIUS],
        ];
        for (const [dx, dy] of offsets) {
          sp.x = pt.x + dx;
          sp.y = pt.y + dy;
          if (el.isPointInStroke(sp)) return true;
        }
        return false;
      }
    } catch (_) {
      /* フォールバックへ */
    }
    try {
      const b = el.getBBox();
      return (
        pt.x >= b.x - ERASER_RADIUS &&
        pt.x <= b.x + b.width + ERASER_RADIUS &&
        pt.y >= b.y - ERASER_RADIUS &&
        pt.y <= b.y + b.height + ERASER_RADIUS
      );
    } catch (_) {
      return false;
    }
  }

  function undo() {
    const el = state.undoStack.pop();
    if (el && el.parentNode) el.remove();
  }

  function clearAll() {
    if (!state.undoStack.length && !svg.querySelector(".pa-ink")) return;
    if (!confirm("書き込みをすべて消去しますか？")) return;
    svg.querySelectorAll(".pa-ink").forEach((el) => el.remove());
    state.undoStack = [];
  }

  // =========================================================
  // ポインタイベント
  // =========================================================
  svg.addEventListener("pointerdown", (e) => {
    if (!state.enabled) return;
    if (e.pointerType === "mouse" && e.button !== 0) return; // 右/中クリックは描画しない
    e.preventDefault();
    svg.setPointerCapture && svg.setPointerCapture(e.pointerId);
    updateCursor(toDocPoint(e));
    startDraw(e);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!state.enabled) return;
    updateCursor(toDocPoint(e)); // 押していなくても色付きカーソルが追従
    if (!state.drawing) return;
    e.preventDefault();
    moveDraw(e);
  });
  const finish = () => {
    if (!state.enabled) return;
    endDraw();
  };
  svg.addEventListener("pointerup", finish);
  svg.addEventListener("pointercancel", finish);
  svg.addEventListener("pointerleave", () => {
    finish();
    hideCursor();
  });

  // =========================================================
  // ダブルクリックで マウスモード ⇔ 描画モード を切替
  // 右W（右ダブルクリック）か 左W（左ダブルクリック）かを設定で選べる。
  // パレットが表示されている間だけ有効。
  // =========================================================

  // 右W: contextmenu を2回拾って判定。検出を確実にするため、
  // 右W設定かつパレット表示中はブラウザの右クリックメニューを抑止する。
  let lastCtxTime = 0;
  window.addEventListener(
    "contextmenu",
    (e) => {
      if (!stored.visible) return; // パレット非表示なら通常のメニュー
      if (!cycleActive()) return; // 巡回対象が1つ以下なら通常のメニュー
      if (stored.toggleClick !== "right") return; // 左W設定なら通常のメニュー
      if (e.target.closest && e.target.closest("#pa-toolbar")) return; // ツールバー上は対象外
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      if (now - lastCtxTime < DBLCLICK_MS) {
        lastCtxTime = 0;
        cycleMode();
      } else {
        lastCtxTime = now;
      }
    },
    true
  );

  // 左W: ネイティブの dblclick をそのまま利用
  window.addEventListener(
    "dblclick",
    (e) => {
      if (!stored.visible) return;
      if (!cycleActive()) return; // 巡回対象が1つ以下なら無効
      if (stored.toggleClick !== "left") return;
      if (e.target.closest && e.target.closest("#pa-toolbar")) return; // ツールバー上は対象外
      e.preventDefault();
      e.stopPropagation();
      cycleMode();
    },
    true
  );

  // =========================================================
  // ツールバー UI
  // =========================================================
  const bar = document.createElement("div");
  bar.id = "pa-toolbar";
  bar.style.zIndex = String(Z);
  bar.style.display = "none";

  bar.innerHTML = `
    <div class="pa-row pa-headbar">
      <span class="pa-grip" title="ドラッグで移動">⠿</span>
      <span class="pa-palswitch">
        <button class="pa-btn pa-pal" data-pal="full" title="詳細パレット">詳細</button>
        <button class="pa-btn pa-pal" data-pal="simple" title="簡単パレット">簡単</button>
      </span>
    </div>
    <div class="pa-row pa-modebar">
      <button class="pa-btn pa-modebtn" id="pa-mode" title="クリック / ダブルクリックで切替"></button>
    </div>
    <div class="pa-row pa-simplemodes"></div>
    <div class="pa-row pa-cycleopt">
      <span class="pa-label">巡回対象</span>
      <span class="pa-cyclechecks">
        <label class="pa-check"><input type="checkbox" data-cyc="pen"> ペン</label>
        <label class="pa-check"><input type="checkbox" data-cyc="highlighter"> 蛍光</label>
        <label class="pa-check"><input type="checkbox" data-cyc="laser"> レーザー</label>
        <label class="pa-check"><input type="checkbox" data-cyc="eraser"> 消し</label>
      </span>
    </div>
    <div class="pa-row pa-toggleopt">
      <span class="pa-label">切替操作</span>
      <button class="pa-btn pa-tg" data-tg="right" title="右ダブルクリックで切替">右W</button>
      <button class="pa-btn pa-tg" data-tg="left" title="左ダブルクリックで切替">左W</button>
    </div>
    <div class="pa-row pa-tools">
      <button class="pa-btn pa-tool" data-tool="pen" title="ペン">✏️ ペン</button>
      <button class="pa-btn pa-tool" data-tool="highlighter" title="蛍光ペン">🖍 蛍光</button>
      <button class="pa-btn pa-tool" data-tool="laser" title="レーザーポインタ（一定時間で消える）">🔴 レーザー</button>
      <button class="pa-btn pa-tool" data-tool="line" title="直線">／ 直線</button>
      <button class="pa-btn pa-tool" data-tool="arrow" title="矢印">↗ 矢印</button>
      <button class="pa-btn pa-tool" data-tool="circle" title="円（ドラッグで描く）">○ 円</button>
      <button class="pa-btn pa-tool" data-tool="eraser" title="消しゴム">⌫ 消し</button>
    </div>
    <div class="pa-row pa-fadeopt">
      <span class="pa-label">残存秒</span>
      <span class="pa-fades"></span>
    </div>
    <div class="pa-row pa-pencolors">
      <span class="pa-label">ペン</span>
      <span class="pa-swatches" data-group="pen"></span>
    </div>
    <div class="pa-row pa-hlcolors">
      <span class="pa-label">蛍光</span>
      <span class="pa-swatches" data-group="hl"></span>
    </div>
    <div class="pa-row pa-actions">
      <button class="pa-btn" id="pa-undo" title="元に戻す">↶ 戻す</button>
      <button class="pa-btn" id="pa-clear" title="全消去">🗑 全消去</button>
      <button class="pa-btn pa-primary" id="pa-save" title="書き込み込みで保存">💾 保存</button>
      <button class="pa-btn" id="pa-close" title="閉じる（描画オフ）">✕</button>
    </div>
    <div class="pa-row pa-status"><span id="pa-status"></span></div>
  `;

  document.documentElement.appendChild(bar);

  makeDraggable(bar, bar.querySelector(".pa-headbar"));

  // 色スウォッチ生成
  const penSwatchWrap = bar.querySelector('[data-group="pen"]');
  PEN_COLORS.forEach((c) => {
    const s = document.createElement("button");
    s.className = "pa-swatch";
    s.style.background = c.value;
    s.title = c.name;
    s.dataset.color = c.value;
    s.dataset.group = "pen";
    penSwatchWrap.appendChild(s);
  });
  const hlSwatchWrap = bar.querySelector('[data-group="hl"]');
  HL_COLORS.forEach((c) => {
    const s = document.createElement("button");
    s.className = "pa-swatch";
    s.style.background = c.value;
    s.title = c.name;
    s.dataset.color = c.value;
    s.dataset.group = "hl";
    hlSwatchWrap.appendChild(s);
  });

  // 簡単パレット用のモード直接切替ボタン生成（ペン/蛍光/レーザー/消し/マウス）
  // 絵文字なしのテキストのみ。表示可否は巡回対象チェックで切り替える（マウスは常に表示）。
  // レーザーは名前が長く1行に収まらないため簡単パレットだけ半角カナで表示
  const SIMPLE_MODE_LABELS = { laser: "ﾚｰｻﾞｰ" };
  const simpleModesWrap = bar.querySelector(".pa-simplemodes");
  CYCLE.forEach((key) => {
    const b = document.createElement("button");
    b.className = "pa-btn pa-smode";
    b.dataset.smode = key;
    b.textContent = SIMPLE_MODE_LABELS[key] || MODE_META[key].name;
    b.title = MODE_META[key].name + "モードに切替";
    simpleModesWrap.appendChild(b);
  });

  // 残存秒（レーザー）ボタン生成
  const fadeWrap = bar.querySelector(".pa-fades");
  FADE_OPTIONS.forEach((sec) => {
    const b = document.createElement("button");
    b.className = "pa-btn pa-fade";
    b.dataset.fade = String(sec);
    b.textContent = sec + "秒";
    b.title = "レーザーの書き込みが " + sec + " 秒で消える";
    fadeWrap.appendChild(b);
  });

  // =========================================================
  // 状態の保存と反映
  // =========================================================
  function persist() {
    try {
      chrome.storage.local.set({ paState: stored });
    } catch (e) {
      /* コンテキスト無効化時など。無視 */
    }
  }

  // ユーザ操作による状態変更 → メモリ更新・画面反映・保存
  function saveState(partial) {
    Object.assign(stored, partial);
    render();
    persist();
  }

  // 描画モードの実効ON/OFFをオーバーレイへ反映
  function setEnabled(on) {
    state.enabled = on;
    svg.style.pointerEvents = on ? "auto" : "none";
    svg.style.touchAction = on ? "none" : "";
    svg.style.cursor = on ? "crosshair" : "";
    bar.classList.toggle("pa-drawing", on);
  }

  // stored の内容を画面へ反映（保存はしない）
  function render() {
    state.tool = stored.tool || "pen";
    state.penColor = stored.penColor || PEN_COLORS[0].value;
    state.hlColor = stored.hlColor || HL_COLORS[0].value;

    bar.classList.toggle("pa-simple", stored.palette === "simple");

    const visible = !!stored.visible;
    bar.style.display = visible ? "block" : "none";
    setEnabled(visible && stored.enabled !== false);

    // 非描画モード（マウス）ではカーソルプレビューを隠す。
    // 描画モードのときは次の pointermove でツールに応じて再表示される。
    if (!(visible && stored.enabled !== false)) {
      hideCursor();
    }

    // 位置反映はパレットを表示状態にしてから（サイズが確定してから）行い、
    // ビューポート外に出ないようクランプする。
    repositionInBounds();

    updateModeUI();
    refreshUI();
  }

  function updateModeUI() {
    const b = bar.querySelector("#pa-mode");
    if (!b) return;
    const key = currentStateKey(); // pen/highlighter/laser/eraser/mouse/line/arrow
    const meta = MODE_META[key] || MODE_META.pen;
    let txt = meta.icon + " " + meta.name;
    // 詳細パレットで巡回が機能するときだけ「（xWで次のモード）」ヒントを添える
    // （簡単パレットは省スペース優先でヒントを出さない）
    if (stored.palette !== "simple" && cycleActive()) {
      const k = stored.toggleClick === "left" ? "左W" : "右W";
      txt += "（" + k + "で" + MODE_META[nextModeKey(key)].name + "）";
    }
    b.textContent = txt;
    b.classList.toggle("pa-active", key !== "mouse");
    b.classList.toggle("pa-mouse", key === "mouse");
  }

  function refreshUI() {
    bar.querySelectorAll("[data-cyc]").forEach((cb) => {
      cb.checked = isCycleEnabled(cb.dataset.cyc);
    });
    bar.querySelectorAll(".pa-pal").forEach((b) => {
      b.classList.toggle("pa-active", b.dataset.pal === (stored.palette || "full"));
    });
    bar.querySelectorAll(".pa-tg").forEach((b) => {
      b.classList.toggle("pa-active", b.dataset.tg === (stored.toggleClick || "right"));
    });
    bar.querySelectorAll(".pa-fade").forEach((b) => {
      b.classList.toggle("pa-active", Number(b.dataset.fade) === (Number(stored.fadeSec) || 3));
    });
    bar.querySelectorAll(".pa-tool").forEach((b) => {
      b.classList.toggle("pa-active", b.dataset.tool === state.tool);
    });
    // 簡単パレットの直接切替ボタン: 巡回対象のものだけ表示し、現在モードを強調
    const curKey = currentStateKey();
    bar.querySelectorAll(".pa-smode").forEach((b) => {
      const key = b.dataset.smode;
      b.style.display = isCycleEnabled(key) ? "" : "none";
      b.classList.toggle("pa-active", key === curKey && key !== "mouse");
      b.classList.toggle("pa-mouse", key === curKey && key === "mouse");
    });
    bar.querySelectorAll('.pa-swatch[data-group="pen"]').forEach((b) => {
      b.classList.toggle("pa-active", b.dataset.color === state.penColor);
    });
    bar.querySelectorAll('.pa-swatch[data-group="hl"]').forEach((b) => {
      b.classList.toggle("pa-active", b.dataset.color === state.hlColor);
    });
  }

  // 現在の状態キーを判定: マウスモードなら "mouse"、描画中なら現在のツール名
  function currentStateKey() {
    if (!(stored.visible && stored.enabled !== false)) return "mouse";
    return stored.tool || "pen";
  }

  // Wクリック / モードボタンで ペン → 蛍光 → レーザー → 消し → マウス … と巡回
  // （パレットは出したまま）
  function cycleMode() {
    if (!stored.visible) return;
    applyModeState(nextModeKey(currentStateKey()));
  }

  // モードボタンの操作: シングルクリックで巡回、ダブルクリックでマウスへ。
  // 巡回（通常操作）と競合しないよう、判定の受付時間は短め。1回目のクリックは
  // この時間だけ巡回を保留し、その間に2回目が来たらマウスモードへ切り替える。
  const MODE_DBL_MS = 220; // モードボタンのダブルクリック判定（短め）
  let modeClickTimer = null;
  function handleModeButtonClick() {
    if (modeClickTimer) {
      clearTimeout(modeClickTimer);
      modeClickTimer = null;
      applyModeState("mouse"); // ダブルクリック → マウスへ戻す
      return;
    }
    modeClickTimer = setTimeout(() => {
      modeClickTimer = null;
      cycleMode(); // シングルクリック → 巡回
    }, MODE_DBL_MS);
  }

  // 指定したモードキーへ遷移して状態表示を更新する
  function applyModeState(key) {
    if (key === "mouse") {
      saveState({ enabled: false });
    } else {
      const patch = { enabled: true, tool: key };
      if (key !== "laser") patch.writeTool = key; // 書き込み系ツールを記憶
      saveState(patch);
    }
    setStatus((MODE_META[key] || MODE_META.pen).name + "モード", false);
    setTimeout(() => setStatus("", false), 1500);
  }

  function setStatus(text, isError) {
    const s = bar.querySelector("#pa-status");
    if (!s) return;
    s.textContent = text || "";
    s.classList.toggle("pa-error", !!isError);
  }

  // ---- ツールバーのクリック処理 ----
  bar.addEventListener("click", (e) => {
    if (e.target.closest("#pa-mode")) {
      handleModeButtonClick();
      return;
    }
    const smodeBtn = e.target.closest(".pa-smode");
    if (smodeBtn) {
      applyModeState(smodeBtn.dataset.smode); // 直接そのモードへ切替
      return;
    }
    const palBtn = e.target.closest(".pa-pal");
    if (palBtn) {
      saveState({ palette: palBtn.dataset.pal });
      return;
    }
    const tgBtn = e.target.closest(".pa-tg");
    if (tgBtn) {
      saveState({ toggleClick: tgBtn.dataset.tg });
      setStatus(tgBtn.dataset.tg === "left" ? "左ダブルクリックで切替" : "右ダブルクリックで切替", false);
      setTimeout(() => setStatus("", false), 1500);
      return;
    }
    const fadeBtn = e.target.closest(".pa-fade");
    if (fadeBtn) {
      saveState({ fadeSec: Number(fadeBtn.dataset.fade) });
      setStatus("レーザー残存 " + fadeBtn.dataset.fade + " 秒", false);
      setTimeout(() => setStatus("", false), 1500);
      return;
    }
    const toolBtn = e.target.closest(".pa-tool");
    if (toolBtn) {
      const t = toolBtn.dataset.tool;
      const patch = { tool: t, enabled: true };
      if (t !== "laser") patch.writeTool = t; // 書き込み系ツールを記憶
      saveState(patch);
      return;
    }
    const sw = e.target.closest(".pa-swatch");
    if (sw) {
      if (sw.dataset.group === "pen") {
        // ペン/図形/レーザーはペン色を共有。レーザー中は色だけ変える
        const nextTool =
          state.tool === "highlighter" || state.tool === "eraser" ? "pen" : state.tool;
        saveState({ penColor: sw.dataset.color, tool: nextTool, enabled: true });
      } else {
        saveState({ hlColor: sw.dataset.color, tool: "highlighter", enabled: true });
      }
      return;
    }
    if (e.target.closest("#pa-undo")) return undo();
    if (e.target.closest("#pa-clear")) return clearAll();
    if (e.target.closest("#pa-close")) return saveState({ visible: false });
    if (e.target.closest("#pa-save")) return doSave();
  });

  // 巡回対象チェックボックス（状態ごとに巡回へ含める/外す）
  bar.addEventListener("change", (e) => {
    const cb = e.target.closest("[data-cyc]");
    if (!cb) return;
    const key = cb.dataset.cyc;
    const next = Object.assign({}, stored.cycleStates, { [key]: cb.checked });
    saveState({ cycleStates: next });
    setStatus(
      MODE_META[key].name + (cb.checked ? "を巡回に追加" : "を巡回から除外"),
      false
    );
    setTimeout(() => setStatus("", false), 1500);
  });

  // =========================================================
  // 保存（MHTML）
  // =========================================================
  function buildFilename() {
    const title = (document.title || "page").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60);
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const ts =
      d.getFullYear() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      "_" +
      pad(d.getHours()) +
      pad(d.getMinutes()) +
      pad(d.getSeconds());
    return title + "_" + ts;
  }

  function doSave() {
    setStatus("保存中…", false);
    // 保存物にツールバーが写り込まないよう一時的に隠す（書き込みは残す）
    bar.style.display = "none";
    svg.style.pointerEvents = "none";
    svg.style.cursor = "";

    chrome.runtime.sendMessage(
      { type: "SAVE_MHTML", filename: buildFilename() },
      (res) => {
        render(); // 表示状態を stored から復元

        if (chrome.runtime.lastError) {
          setStatus("保存失敗: " + chrome.runtime.lastError.message, true);
          return;
        }
        if (res && res.ok) {
          setStatus("保存しました（.mhtml）", false);
          setTimeout(() => setStatus("", false), 4000);
        } else {
          setStatus("保存失敗: " + ((res && res.error) || "不明なエラー"), true);
        }
      }
    );
  }

  // =========================================================
  // ドラッグ移動ヘルパ
  // =========================================================
  // 位置をインライン !important で指定する。
  // content.css の top/right は !important のため、インラインも !important に
  // しないと縦移動や右側の解除が効かない（上端の左右にしか動かなくなる）。
  // left/top はビューポート上の見かけ位置（ズーム非依存）で受け取り保存する。
  // ツールバーには zoom:zoomScale が掛かっており、left/top はその座標系で
  // 解釈される（zoom 倍される）ため、保存値を zoomScale で割って打ち消す。
  function setPanelPos(el, left, top) {
    const z = zoomScale || 1;
    const s = el.style;
    s.setProperty("left", left / z + "px", "important");
    s.setProperty("top", top / z + "px", "important");
    s.setProperty("right", "auto", "important");
    s.setProperty("bottom", "auto", "important");
  }

  // 見かけ位置（ビューポート CSS px）をブラウザウィンドウ内に収める。
  // ページ拡大やウィンドウ縮小でビューポートが狭まっても、パレットが
  // 画面外へ出ないよう端でクランプする。
  const EDGE_MARGIN = 4;
  function clampToViewport(left, top) {
    const rect = bar.getBoundingClientRect();
    const w = rect.width || 0;
    const h = rect.height || 0;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const maxLeft = Math.max(EDGE_MARGIN, vw - w - EDGE_MARGIN);
    const maxTop = Math.max(EDGE_MARGIN, vh - h - EDGE_MARGIN);
    return {
      left: Math.min(Math.max(EDGE_MARGIN, left), maxLeft),
      top: Math.min(Math.max(EDGE_MARGIN, top), maxTop),
    };
  }

  // 現在のビューポートでパレットが動ける範囲（左上0 〜 右下avail）を返す。
  function availSpace() {
    const rect = bar.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return {
      availW: Math.max(1, vw - rect.width),
      availH: Math.max(1, vh - rect.height),
    };
  }

  // 保存した割合位置を、現在のビューポートに合わせて px へ展開して再配置する。
  // 既定位置（未ドラッグ）は CSS の right/top 指定に任せる。
  function repositionInBounds() {
    if (stored.leftFrac == null || stored.topFrac == null) return;
    if (bar.style.display === "none") return; // 非表示中はサイズが取れない
    const { availW, availH } = availSpace();
    const c = clampToViewport(stored.leftFrac * availW, stored.topFrac * availH);
    setPanelPos(bar, c.left, c.top);
  }

  function makeDraggable(panel, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.style.cursor = "move";
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return; // ボタン操作は妨げない
      dragging = true;
      const rect = panel.getBoundingClientRect();
      ox = rect.left;
      oy = rect.top;
      sx = e.clientX;
      sy = e.clientY;
      setPanelPos(panel, ox, oy);
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const c = clampToViewport(ox + (e.clientX - sx), oy + (e.clientY - sy));
      setPanelPos(panel, c.left, c.top);
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      const rect = panel.getBoundingClientRect();
      const c = clampToViewport(rect.left, rect.top);
      // 見かけ位置を可動範囲に対する割合へ変換して保存（ズーム非依存の相対位置）
      const { availW, availH } = availSpace();
      saveState({ leftFrac: c.left / availW, topFrac: c.top / availH });
    };
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
  }

  // =========================================================
  // ページズーム補正（ツールバーの見かけサイズを固定）
  // =========================================================
  // 現在のページズーム倍率（読み込み時基準）に対し、ツールバーへ逆向きの
  // zoom を当てて拡大・縮小を打ち消す。位置も新しい倍率で取り直す。
  function applyZoomCompensation() {
    const dpr = window.devicePixelRatio || 1;
    const next = BASE_DPR / dpr;
    if (Math.abs(next - zoomScale) < 0.001) return; // 変化なしなら何もしない
    zoomScale = next;
    bar.style.setProperty("zoom", String(zoomScale), "important");
    // ドラッグ済みの位置は新しい倍率で再計算しつつ画面内へ収める
    repositionInBounds();
  }
  // ビューポート変化（ページズーム Ctrl +/- やウィンドウのリサイズ）に追従。
  // ズーム倍率の補正と、パレットを画面内へ収めるクランプの両方を行う。
  // ズームは resize を伴って devicePixelRatio を変える。取りこぼし対策に
  // 定期チェックも併用する。
  function onViewportChange() {
    applyZoomCompensation();
    repositionInBounds();
  }
  window.addEventListener("resize", onViewportChange, { passive: true });
  setInterval(onViewportChange, 1000);
  applyZoomCompensation();
  repositionInBounds();

  // =========================================================
  // ストレージ同期（タブ間・再読み込みをまたいで状態を維持）
  // =========================================================
  try {
    chrome.storage.local.get("paState", (got) => {
      if (chrome.runtime.lastError) return;
      if (got && got.paState) Object.assign(stored, got.paState);
      render();
    });
  } catch (e) {
    render();
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.paState) return;
      stored = Object.assign({}, DEFAULTS, changes.paState.newValue || {});
      render();
    });
  } catch (e) {
    /* 無視 */
  }

  // 初期反映
  render();
})();
