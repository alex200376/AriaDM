/**
 * The extension's strings, in one place.
 *
 * Deliberately a plain table rather than `chrome.i18n` and `_locales`: those
 * resolve asynchronously, which would mean every label in the on-page panel
 * renders twice (once empty, once translated), and they need a manifest change
 * plus a reload before a new string is visible. The app already ships exactly two
 * locales — English and Traditional Chinese — so a two-entry table is the whole
 * feature, and it can be read synchronously by a content script, the background
 * worker and the popup alike.
 *
 * The language follows the browser. Anything Chinese takes the Traditional
 * strings, which is what this extension shipped with, so an existing user sees no
 * change; every other locale gets English.
 */
;(function () {
  const ZH = {
    // -- context menus -------------------------------------------------------
    'menu.link': '用 AriaDM 下載連結',
    'menu.media': '用 AriaDM 下載媒體',
    'menu.page': '用 AriaDM 下載此頁面',

    // -- on-page panel -------------------------------------------------------
    'panel.video': '下載此影片',
    'panel.audio': '下載此音訊',
    'panel.send': '{label} — 送到 AriaDM',
    'panel.busy': '正在取得畫質…',
    'panel.done': '已加入 AriaDM',
    'panel.error': '無法加入，請見通知',
    'panel.choose': '選擇畫質',
    'panel.noItem': '請先開啟這則貼文',
    'panel.title': 'AriaDM：這個頁面是動態牆，請先點開那則貼文，再按一次下載。',
    'panel.prefix': 'AriaDM：',

    // -- popup ---------------------------------------------------------------
    'popup.checking': '檢查中…',
    'popup.connected': '已連線 · {count} 進行中',
    'popup.disconnected': '未連線',
    'popup.downloadVideo': '下載此頁面的影片',
    'popup.sendLinks': '傳送所有連結',
    'popup.intercept': '攔截瀏覽器下載',
    'popup.interceptHint': '開啟後，瀏覽器開始的下載會被取消並改由 AriaDM 接手。',
    'popup.sendCookies': '傳送登入狀態',
    'popup.reconnect': '重新連線',
    'popup.advanced': '進階：手動指定連線',
    'popup.advancedHint': '擴充功能會自動找到 AriaDM。只有在自動探索的連接埠被其他程式占用時，才需要在這裡手動填寫。',
    'popup.port': '連接埠',
    'popup.token': '權杖（設定 → 整合與工具）',
    'popup.save': '儲存手動設定',
    'popup.pageBlocked': '這個頁面無法下載（僅支援 http/https）。',
    'popup.pageUnknown': '沒偵測到影音網站；仍可嘗試下載，或傳送頁面連結。',
    'popup.pageItem': '偵測到影音網站，可直接下載這部影片。',
    'popup.pageFeed': '這是列表頁，沒有可直接下載的影片；請先開啟那則貼文或影片頁面。',
    'popup.chooseQuality': '選擇畫質',
    'popup.gettingFormats': '正在取得影片…',
    'popup.adding': '正在加入下載…',
    'popup.added': '已加入影片下載',
    'popup.collecting': '收集連結中…',
    'popup.noLinks': '此頁面沒有可下載的連結',
    'popup.readLinksFailed': '無法讀取頁面連結：{message}',
    'popup.sentCount': '已送出 {count} 個項目',
    'popup.sendingLogin': '正在傳送登入狀態…',
    'popup.loginSent': '已把登入狀態傳給 AriaDM',
    'popup.loginRejected': 'AriaDM 目前不接受登入狀態（請在設定中開啟）',
    'popup.searching': '正在尋找 AriaDM…',
    'popup.foundPort': '已連線到連接埠 {port}',
    'popup.notFound': '找不到 AriaDM。請先啟動桌面應用程式，並確認「設定 → 整合與工具」中的瀏覽器整合已開啟。',
    'popup.needBoth': '請同時填寫連接埠與權杖',
    'popup.saved': '已儲存手動設定',
    'popup.unknownError': '未知錯誤',
    'popup.failed': '失敗：{message}',
    'popup.notConnectedHint': '未連線：請啟動 AriaDM 桌面應用程式，連線後會自動完成設定。',
    'popup.cookieServed': '已把 {host} 的登入狀態傳給 AriaDM。',
    'popup.thisSite': '這個網站',

    // -- notifications -------------------------------------------------------
    'notify.disconnected': 'AriaDM 未連線',
    'notify.startApp': '請先啟動 AriaDM 桌面應用程式。',
    'notify.findApp': '找不到 AriaDM。請啟動桌面應用程式，並確認「設定 → 整合與工具」中的瀏覽器整合已啟用。',
    'notify.rejected': 'AriaDM 無法接收',
    'notify.notice': 'AriaDM 提示',
    'notify.noResponse': 'AriaDM 沒有回應',
    'notify.loginTitle': 'AriaDM 已取得登入狀態',
    'notify.loginBody': '已把 {host} 的 Cookie 傳給 AriaDM。',

    // -- badge tooltip -------------------------------------------------------
    'badge.connected': 'AriaDM：已連線',
    'badge.connectedPort': 'AriaDM：已連線（自動配對 :{port}）',
    'badge.disconnected': 'AriaDM：未連線（請啟動 AriaDM 桌面程式）',

    // -- transport and other errors ------------------------------------------
    'menu.auto': '自動選擇最佳畫質',
    'error.connect': '無法連線到 AriaDM：請確認應用程式正在執行，或按「重新連線」。',
    'error.unknown': '未知錯誤',
    'error.pairFailed':
      '找不到 AriaDM（已嘗試連接埠 {ports}）。請確認應用程式正在執行，且「設定 → 整合與工具」中已啟用瀏覽器整合。',
    'error.notPaired': '尚未配對',
    'error.noPage': '這個頁面無法下載',
    'error.noCookies': '這個網址沒有可用的 Cookie'
  }

  const EN = {
    'menu.link': 'Download link with AriaDM',
    'menu.media': 'Download media with AriaDM',
    'menu.page': 'Download this page with AriaDM',

    'panel.video': 'Download this video',
    'panel.audio': 'Download this audio',
    'panel.send': '{label} — send to AriaDM',
    'panel.busy': 'Getting qualities…',
    'panel.done': 'Added to AriaDM',
    'panel.error': 'Could not add it; see the notification',
    'panel.choose': 'Choose quality',
    'panel.noItem': 'Open the post first',
    'panel.title': 'AriaDM: this is a feed, not a video page. Open the post, then press download again.',
    'panel.prefix': 'AriaDM: ',

    'popup.checking': 'Checking…',
    'popup.connected': 'Connected · {count} active',
    'popup.disconnected': 'Not connected',
    'popup.downloadVideo': 'Download this page’s video',
    'popup.sendLinks': 'Send all links',
    'popup.intercept': 'Intercept browser downloads',
    'popup.interceptHint':
      'While this is on, a download the browser starts is cancelled and handed to AriaDM instead.',
    'popup.sendCookies': 'Send login state',
    'popup.reconnect': 'Reconnect',
    'popup.advanced': 'Advanced: set the connection by hand',
    'popup.advancedHint':
      'The extension finds AriaDM on its own. Only fill this in when another program has taken the discovery port.',
    'popup.port': 'Port',
    'popup.token': 'Token (Settings → Integrations & tools)',
    'popup.save': 'Save manual settings',
    'popup.pageBlocked': 'This page cannot be downloaded (http/https only).',
    'popup.pageUnknown': 'No video site detected; you can still try, or send the page link.',
    'popup.pageItem': 'Video site detected — this video can be downloaded directly.',
    'popup.pageFeed': 'This is a listing page with no downloadable video; open the post or the video page first.',
    'popup.chooseQuality': 'Choose quality',
    'popup.gettingFormats': 'Getting the video…',
    'popup.adding': 'Adding the download…',
    'popup.added': 'Video download added',
    'popup.collecting': 'Collecting links…',
    'popup.noLinks': 'This page has no downloadable links',
    'popup.readLinksFailed': 'Could not read the page’s links: {message}',
    'popup.sentCount': 'Sent {count} item(s)',
    'popup.sendingLogin': 'Sending the login state…',
    'popup.loginSent': 'The login state was sent to AriaDM',
    'popup.loginRejected': 'AriaDM is not accepting a login state right now (enable it in Settings)',
    'popup.searching': 'Looking for AriaDM…',
    'popup.foundPort': 'Connected on port {port}',
    'popup.notFound':
      'AriaDM was not found. Start the desktop app, and make sure the browser integration is on in Settings → Integrations & tools.',
    'popup.needBoth': 'Fill in both the port and the token',
    'popup.saved': 'Manual settings saved',
    'popup.unknownError': 'Unknown error',
    'popup.failed': 'Failed: {message}',
    'popup.notConnectedHint': 'Not connected: start the AriaDM desktop app; pairing completes by itself.',
    'popup.cookieServed': 'Sent the {host} login state to AriaDM.',
    'popup.thisSite': 'this site',

    'notify.disconnected': 'AriaDM is not connected',
    'notify.startApp': 'Start the AriaDM desktop app first.',
    'notify.findApp':
      'AriaDM was not found. Start the desktop app, and make sure the browser integration is on in Settings → Integrations & tools.',
    'notify.rejected': 'AriaDM rejected it',
    'notify.notice': 'AriaDM notice',
    'notify.noResponse': 'AriaDM did not respond',
    'notify.loginTitle': 'AriaDM received the login state',
    'notify.loginBody': 'Sent the {host} cookies to AriaDM.',

    'badge.connected': 'AriaDM: connected',
    'badge.connectedPort': 'AriaDM: connected (auto-paired on :{port})',
    'badge.disconnected': 'AriaDM: not connected (start the AriaDM desktop app)',

    'menu.auto': 'Best available quality',
    'error.connect': 'Could not reach AriaDM: make sure the app is running, or press “Reconnect”.',
    'error.unknown': 'Unknown error',
    'error.pairFailed':
      'AriaDM was not found (tried ports {ports}). Make sure the app is running and that the browser integration is on in Settings → Integrations & tools.',
    'error.notPaired': 'Not paired yet',
    'error.noPage': 'This page cannot be downloaded',
    'error.noCookies': 'No usable cookies for this address'
  }

  /** The locale to use. `chrome.i18n` when it exists, then `navigator`. */
  function resolveLanguage() {
    let tag = ''
    try {
      tag = (chrome.i18n?.getUILanguage?.() || navigator.language || '').toLowerCase()
    } catch {
      tag = ''
    }
    return tag
  }

  /**
   * Translate a key, substituting `{name}` placeholders.
   *
   * A missing key returns the key itself rather than an empty string: a blank
   * label looks like a layout bug, whereas a raw key names the mistake.
   */
  function t(key, substitutions) {
    const table = /^zh/.test(resolveLanguage()) ? ZH : EN
    const template = table[key] ?? ZH[key] ?? key
    if (!substitutions) return template
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(substitutions, name) ? String(substitutions[name]) : match
    )
  }

  self.AriaDmStrings = { t, language: resolveLanguage() }
})()
