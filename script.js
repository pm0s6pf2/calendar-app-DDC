// ====== 設定 ======
// ※ 必ずあなたの OAuth クライアントIDに置き換えてください（Step1 と同じもの）
const CLIENT_ID = "432542663306-gajl9s636n960rmul1a630e2k9lchdl3.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/drive.readonly";
const TIMEZONE = "Asia/Tokyo"; // テスト項目でのタイムゾーンズレ対策
const CACHE_NAME = "image-cache-v1" ;
const nav = document.getElementById("navAll");

// ====== 状態 ======
let tokenClient;
let gapiReady = false;
let gisReady = false;
let lastObjectURL = null; // 直前の Blob URL を保持（失敗時は前の画像を残す）
let currentDate = new Date(); //今表示している日付
// ====== スライド用 ======
let slideDates = [];
let slideIndex = 0;
let slideTimer = null;
let slideDirection = 1;
let slideSpeed = 2000;
let monthDayCache = {};
let isSlideshowRunning = false;

// ====== ユーティリティ ======
const $ = (sel) => document.querySelector(sel);
function setStatus(msg, isError = false) {
    const el = $("#status");
    el.textContent = msg;
    el.style.color = isError ? "crimson" : "#0056b3";
}
function showOverlay(message) {
    const el = $("#overlay");
    el.textContent = message;
    el.classList.add("show");
}
function hideOverlay() {
    const el = $("#overlay");
    el.textContent = "";
    el.classList.remove("show");
}
function clearImage() {
    if (lastObjectURL) URL.revokeObjectURL(lastObjectURL);
    lastObjectURL = null;
    $("#photo").src = "";
    $("#filename").textContent = "";
    hideOverlay();
}
function getSavedFolderId() {
    return localStorage.getItem("selectedFolderId"); }
function dateToYMD(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(date);
    const y = parts.find(p => p.type === "year").value;
    const m = parts.find(p => p.type === "month").value;
    const d = parts.find(p => p.type === "day").value;
    return `${y}-${m}-${d}`;
}

async function ensureToken() {
    let token = gapi.client.getToken();
    if (!token) {
    await new Promise((resolve) => {
        tokenClient.callback = () => resolve();
        tokenClient.requestAccessToken({ prompt: "" }); // サイレント更新
    });
    token = gapi.client.getToken();
    }
    return token.access_token;
}

async function findImageFile(folderId, baseName) {
    // まずは .png を優先（テスト要件）。見つからなければ jpg/jpeg も試す。
    const names = [`${baseName}.png`, `${baseName}.jpg`, `${baseName}.jpeg`];
    for (const name of names) {
    try {
        const res = await gapi.client.drive.files.list({
        q: `'${folderId}' in parents and name='${name}' and trashed=false`,
        fields: "files(id,name,mimeType,size,modifiedTime)",
        pageSize: 1,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        });
        const files = res.result.files || [];
        if (files.length > 0) return files[0];
    } catch (e) {
        if (e.status === 401) { await ensureToken(); continue; }
        throw e;
    }
    }
    return null;
}

async function displayByBaseName(folderId, baseName) {
    setStatus("検索中…");
    hideOverlay();
    try {
    // 1 先にキャッシュを確認
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(baseName);
    if (cachedResponse) {
        const blob = await cachedResponse.blob();
        if (lastObjectURL) URL.revokeObjectURL(lastObjectURL);
        lastObjectURL = URL.createObjectURL(blob);
        $("#photo").src = lastObjectURL;
        $("#filename").textContent = `${baseName}（キャッシュから表示）`;
        // キャッシュ命中時
        setStatus(`✅ キャッシュから表示: ${baseName}`);
        return true;
    }

    // 2 Drive からファイル検索
            const file = await findImageFile(folderId, baseName);
    if (!file) {
        setStatus("画像が見つかりません");
        showOverlay(`"${baseName}.png" が見つかりませんでした。\nフォルダやファイル名（YYYY-MM-DD.png）を確認してください。`);
        return false; // 失敗
    }

    const accessToken = await ensureToken();
    const url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) {
        if (resp.status === 401) { await ensureToken(); return await displayByBaseName(folderId, baseName); }
        throw new Error(`取得失敗: ${resp.status}`);
    }
    const blob = await resp.blob();

    // --- ここでキャッシュ保存 ---
    const responseForCache = new Response(blob, {
        headers: { "Content-Type": file.mimeType }
    });
    await cache.put(baseName, responseForCache);
    // ----------------------------

    if (lastObjectURL) URL.revokeObjectURL(lastObjectURL);
    lastObjectURL = URL.createObjectURL(blob);
    $("#photo").src = lastObjectURL;
    $("#filename").textContent = `${file.name}（最終更新: ${new Date(file.modifiedTime).toLocaleString('ja-JP', { timeZone: TIMEZONE })}）`;
    // Driveから新規取得成功時
    setStatus(`🌐 ネットワークから取得して表示: ${file.name}`);
    await showCacheUsage(); // ← キャッシュ状況を更新   
    return true; // 成功
    } catch (e) {
    console.error(e);
    setStatus("エラー: " + e.message, true);
    showOverlay("通信に失敗しました。再試行してください。");
    return false;
    }
}

// キャッシュ使用量を計算して表示
async function showCacheUsage() {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();

    let totalSize = 0;
    for (const req of keys) {
    const resp = await cache.match(req);
    if (resp) {
        const blob = await resp.blob();
        totalSize += blob.size;
    }
    }
    if (keys.length === 0) {
    $("#cacheInfo").textContent = "キャッシュは空です";
    } else {
    const mb = (totalSize / (1024 * 1024)).toFixed(2);
    $("#cacheInfo").textContent = `キャッシュ使用量: ${mb} MB (${keys.length}ファイル)`;
    }
}


// 指定日付で画像を表示する関数
async function displayByDate(date) {
    const folderId = getSavedFolderId();
    if (!folderId) { openFolderPicker(); return; }
    const ymd = dateToYMD(date);
    const success = await displayByBaseName(folderId, ymd);
    if (success) {
        currentDate = date; // 画像が見つかったときだけ更新
        prefetchAround(folderId, date, 3); // ★ ここで±3日を先読み
        // 👇 スライド中でなければ先読み
        await showCacheUsage();
    }
}

// 今日の画像を表示する
async function displayToday() {
    const today = new Date();
    displayByDate(today);
}

// 先読みキャッシュ: 指定日を中心に±range日をキャッシュ
async function prefetchAround(folderId, centerDateStr, range = 3) {
    const cache = await caches.open(CACHE_NAME);
    const centerDate = (centerDateStr instanceof Date) ? centerDateStr : new Date(centerDateStr);

    for (let offset = -range; offset <= range; offset++) {
    const d = new Date(centerDate);
    d.setDate(centerDate.getDate() + offset);
    const ymd = d.toISOString().slice(0, 10); // YYYY-MM-DD

    // キャッシュ確認
    const cachedResponse = await cache.match(ymd);
    if (cachedResponse) {
        console.log(`📦 ${ymd}: キャッシュ済み`);
        continue;
    }

    // Google Drive から取得
    const file = await findImageFile(folderId, ymd);
    if (!file) {
        console.log(`🚫 ${ymd}: 画像なし`);
        continue;
    }

    const accessToken = await ensureToken();
    const url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

    if (!resp.ok) {
        console.log(`⚠️ ${ymd}: 取得失敗 ${resp.status}`);
        continue;
    }

    // キャッシュ保存
    await cache.put(ymd, resp.clone());
    console.log(`✅ ${ymd}: キャッシュ保存`);
    }
}

function openFolderPicker() {
    $("#picker").style.display = "flex";
    loadFolderList();
}

// キャッシュクリア関数
async function clearCache(){
    if (!confirm("本当にキャッシュをすべて削除しますか？")) return;
    const btn = $("#clearCacheBtn");
    btn.disabled = true;
    try {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    for (const req of keys) {
        // 表示中の画像は削除対象から外す
        if (req.url.endsWith(dateToYMD(currentDate))) continue;
        await cache.delete(req);
    }
    await showCacheUsage();
    setStatus("✅ キャッシュを削除しました");
    } catch (e) {
    setStatus("エラー: " + e.message, true);
    } finally {
    btn.disabled = false;
    }
}

async function loadFolderList() {
    try {
    const res = await gapi.client.drive.files.list({
        q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
        fields: "files(id,name)",
        pageSize: 100,
        orderBy: "name",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
    });
    const sel = $("#folderList");
    sel.innerHTML = "";
    (res.result.files || []).forEach((f) => {
        const opt = document.createElement("option");
        opt.value = f.id;
        opt.textContent = f.name;
        sel.appendChild(opt);
    });
    } catch (e) {
    setStatus("フォルダ取得エラー: " + e.message, true);
    }
}

function afterLogin() {
    setStatus("ログイン成功");
    $("#login").style.display = "none";
    $("#logout").style.display = "inline-block";
    $("#choose").style.display = "inline-block";
    $("#showToday").style.display = "inline-block";

    $("#checkCacheBtn").disabled = false;
    $("#clearCacheBtn").disabled = false;
    nav.classList.remove("hidden"); // 表示

    const saved = getSavedFolderId();
    if (saved) {
    const savedName = localStorage.getItem("selectedFolderName") || "(名前不明)";
    $("#remembered").textContent =`📂フォルダ: ${savedName}`;
    displayToday();
    } else {
    openFolderPicker();
    }

}

// ====== イベント割り当て ======
document.addEventListener("DOMContentLoaded", () => {
    $("#slideAsc").addEventListener("click", () => startSlideshow(1));
    $("#slideDesc").addEventListener("click", () => startSlideshow(-1));
    $("#slideStop").addEventListener("click", stopSlideshow);
    $("#clearCacheBtn").addEventListener("click", clearCache);
    $("#checkCacheBtn").addEventListener("click", showCacheUsage);

    $("#login").addEventListener("click", () => {
    tokenClient.callback = (resp) => {
        if (resp.error) {
        setStatus("認証エラー: " + resp.error, true);
        return;
        }
        gapi.client.setToken(resp); // gapi にアクセストークンを設定
        afterLogin();
    };
    tokenClient.requestAccessToken({ prompt: "consent" });
    });

    $("#logout").addEventListener("click", () => {
        monthDayCache = {};
        try {
            google.accounts.oauth2.revoke(gapi.client.getToken()?.access_token || "", () => {});
        } catch (e) {
            console.warn("revoke でエラー:", e);
        }
        gapi.client.setToken("");
        setStatus("未ログイン");
        $("#login").style.display = "inline-block";
        $("#login").disabled = false;
        $("#logout").style.display = "none";
        $("#choose").style.display = "none";
        $("#showToday").style.display = "none";
        $("#picker").style.display = "none";
        $("#remembered").textContent = "";
        clearImage();

        $("#checkCacheBtn").disabled = true;
        $("#clearCacheBtn").disabled = true;        
    });

        $("#choose").addEventListener("click", openFolderPicker);
        $("#saveFolder").addEventListener("click", () => {
            const id = $("#folderList").value;
            const name = $("#folderList option:checked").textContent;
            if (!id) { setStatus("フォルダを選択してください", true); return; }
            localStorage.setItem("selectedFolderId", id);
            localStorage.setItem("selectedFolderName", name);
            $("#remembered").textContent = `選択中フォルダ名: ${name}`;
            $("#picker").style.display = "none";
            displayToday();
        });

        const viewport = document.querySelector(".viewport");
        viewport.addEventListener("click", () => {
        viewport.classList.toggle("fullscreen");
    });


    $("#showToday").addEventListener("click", displayToday);

    $("#prevDay").addEventListener("click", () => {
    const d = new Date(currentDate);
    d.setDate(d.getDate() - 1);
    displayByDate(d);
    });

    $("#nextDay").addEventListener("click", () => {
    const d = new Date(currentDate);
    d.setDate(d.getDate() + 1);
    displayByDate(d);
    });

    $("#prevYear").addEventListener("click", () => {
    const d = new Date(currentDate);
    d.setFullYear(d.getFullYear() - 1);
    displayByDate(d);
    });

    $("#nextYear").addEventListener("click", () => {
    const d = new Date(currentDate);
    d.setFullYear(d.getFullYear() + 1);
    displayByDate(d);
    });
});

// ====== Google API 初期化 ======
function gapiLoaded() {
    gapi.load("client", async () => {
    await gapi.client.init({
        discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"],
    });
    gapiReady = true;
    enableLoginIfReady();
    });
}

function gisLoaded() {
    tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: () => {}, // 初期は空でOK（クリック時に上書き）
    });
    gisReady = true;
    enableLoginIfReady();
}

function enableLoginIfReady() {
    if (gapiReady && gisReady) {
    document.getElementById("login").disabled = false;
    setStatus("準備完了");
    }
}

async function findSameMonthDayFiles(folderId, monthDay) {
  const cacheKey = folderId + "_" + monthDay;
  if (monthDayCache[cacheKey]) {
    console.log("📦 月日一覧キャッシュ使用");
    return monthDayCache[cacheKey];
  }
  const res = await gapi.client.drive.files.list({
    q: `'${folderId}' in parents and name contains '${monthDay}' and trashed=false`,
    fields: "files(id,name,modifiedTime)",
    pageSize: 100,
  });
  const files = res.result.files || [];
  files.sort((a,b)=>a.name.localeCompare(b.name));
  monthDayCache[cacheKey] = files; // ★ 保存
  console.log("🌐 Driveから月日一覧取得");
  return files;
}

// ====== スライド用事前読み込み ======
async function prefetchSlideshowImages(folderId, baseNames) {
  const cache = await caches.open(CACHE_NAME);
  for (const baseName of baseNames) {
    const cached = await cache.match(baseName);
    if (cached) continue;
    const file = await findImageFile(folderId, baseName);
    if (!file) continue;
    const accessToken = await ensureToken();
    const url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!resp.ok) continue;
    await cache.put(baseName, resp.clone());
    console.log(`📦 スライド用事前取得: ${baseName}`);
  }
}

//スライド開始関数
// ====== スライド開始 ======
async function startSlideshow(direction = 1) {
  if (isSlideshowRunning) return;
  const folderId = getSavedFolderId();
  if (!folderId) return;
  const monthDay = dateToYMD(currentDate).slice(5);
  const files = await findSameMonthDayFiles(folderId, monthDay);
  if (files.length === 0) {
    alert("画像が見つかりません");
    return;
  }
  slideDates = files.map(f =>
    f.name.replace(/\.(png|jpg|jpeg)$/,'')
  );
  const currentBase = dateToYMD(currentDate);
  slideIndex = slideDates.indexOf(currentBase);
  if (slideIndex === -1) slideIndex = 0;
  slideDirection = direction;

  // ★ ここでスライド画像を事前読み込み
  await prefetchSlideshowImages(folderId, slideDates);
  isSlideshowRunning = true;
  nav.classList.add("hidden");
  slideTimer = setInterval(async () => {
    slideIndex += slideDirection;
    if (slideIndex < 0) slideIndex = slideDates.length - 1;
    if (slideIndex >= slideDates.length) slideIndex = 0;
    const base = slideDates[slideIndex];
    await displayByBaseName(folderId, base);
    // ★ 内部日付を更新（超重要）
    currentDate = new Date(base);
  }, slideSpeed);
}

function stopSlideshow() {
  if (!isSlideshowRunning) return;
  clearInterval(slideTimer);
  slideTimer = null;
  isSlideshowRunning = false; // ★ 停止状態に戻す
  nav.classList.remove("hidden"); // 表示
}


$("#speedSelect").addEventListener("change", (e)=>{
  slideSpeed = Number(e.target.value);

  // 動作中なら再スタート
  if (slideTimer) {
    stopSlideshow();
    startSlideshow(slideDirection);
  }
});