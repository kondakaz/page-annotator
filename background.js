// background.js — サービスワーカー
// 役割:
//  1. 拡張アイコンクリックで、アクティブタブのツールバー表示をトグルする
//  2. content.js からの依頼で、現在のページを MHTML（書き込み込み）として保存する

// ---- ツールバーの表示状態をトグル ----
// 表示状態は chrome.storage.local に持たせ、各タブの content.js は
// storage.onChanged で反応する。これによりメッセージ到達のタイミングや
// タブの自動破棄・再読み込みに左右されず、確実に表示/復元できる。
async function toggleVisible() {
  let cur = {};
  try {
    const got = await chrome.storage.local.get("paState");
    cur = got.paState || {};
  } catch (e) {
    /* 取得失敗時は空から開始 */
  }
  cur.visible = !cur.visible;
  if (cur.visible) cur.enabled = true; // 表示するときは描画モードONで開始
  try {
    await chrome.storage.local.set({ paState: cur });
  } catch (e) {
    /* 保存失敗は無視 */
  }
}

// 拡張アイコンの左クリック
chrome.action.onClicked.addListener(() => toggleVisible());

// 拡張アイコンの右クリックメニューからも表示/非表示できるようにする
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "pa-toggle",
      title: "ページ書き込みパレットの表示／非表示",
      contexts: ["action"],
    });
    void chrome.runtime.lastError;
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "pa-toggle") toggleVisible();
});

// ---- ArrayBuffer → base64 文字列（大きいページでも分割して変換）----
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ---- メッセージ受信 ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "SAVE_MHTML") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: "タブ ID を取得できませんでした" });
      return; // 同期で完了
    }

    chrome.pageCapture.saveAsMHTML({ tabId }, async (blob) => {
      if (chrome.runtime.lastError || !blob) {
        sendResponse({
          ok: false,
          error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || "ページの取得に失敗しました",
        });
        return;
      }
      try {
        const buf = await blob.arrayBuffer();
        const base64 = bufferToBase64(buf);
        const dataUrl = "data:application/x-mimearchive;base64," + base64;
        const filename = (msg.filename || "page") + ".mhtml";

        chrome.downloads.download({ url: dataUrl, filename, saveAs: true }, (downloadId) => {
          if (chrome.runtime.lastError || downloadId == null) {
            sendResponse({
              ok: false,
              error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || "ダウンロードに失敗しました",
            });
          } else {
            sendResponse({ ok: true });
          }
        });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    });

    return true; // 非同期で sendResponse するためチャネルを開いたままにする
  }
});
