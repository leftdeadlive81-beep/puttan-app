/* ==================================================
   設定
   ・既存Webアプリ(gps-server)と同じSupabase/Renderバックエンドを共有する
================================================== */

const SUPABASE_URL = "https://seqqgkryrhcvmxnwyybr.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_pUI0REFogJSgZYs3OJepEQ_Zl27Iw73";
const SERVER_URL = "https://gps-server-p5ob.onrender.com";

const SEND_INTERVAL = 30000;
const MOVE_DISTANCE = 10;

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const socket = io(SERVER_URL, {
    transports: ["polling", "websocket"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
});

/* ==================================================
   状態
================================================== */

let currentAuthUser = null;
let socketUserId = null;
let registered = false;
let gpsRunning = false;
let pushNotificationsInitialized = false;

let watchID = null;
let gpsTimer = null;
let lastLat = 0;
let lastLon = 0;
let lastSendTime = 0;

let latestUsersData = {};
let chronology = [];
let olderChronology = [];
let chronologyExhausted = false;

/* ==================================================
   HTMLエスケープ
================================================== */

function escapeHtml(value){
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/* ==================================================
   タブ切替
================================================== */

function showTab(tabId, button){
    document.querySelectorAll(".tabContent").forEach(tab => tab.classList.remove("active"));
    document.querySelectorAll(".tabButton").forEach(btn => btn.classList.remove("active"));

    const tab = document.getElementById(tabId);
    if(tab){ tab.classList.add("active"); }
    if(button){ button.classList.add("active"); }
}

/* ==================================================
   画面切替
================================================== */

function showAuth(){
    document.getElementById("authScreen").style.display = "flex";
    document.getElementById("appScreen").style.display = "none";
}

function showApp(){
    document.getElementById("authScreen").style.display = "none";
    document.getElementById("appScreen").style.display = "block";
}

/* ==================================================
   ログインIDチェック（Web版と同じ規則）
================================================== */

function validateLoginId(loginId){
    if(!loginId){ return "ログインIDを入力してください"; }
    if(loginId.length < 2){ return "ログインIDは2文字以上にしてください"; }
    if(loginId.length > 50){ return "ログインIDは50文字以内にしてください"; }
    if(!/^[A-Za-z0-9]+$/.test(loginId)){ return "ログインIDは英数字のみ使用できます"; }
    return null;
}

function makeAuthEmail(loginId){
    return loginId.trim().toLowerCase() + "@puttan.local";
}

/* ==================================================
   ログイン
================================================== */

async function loginUser(){
    const loginInput = document.getElementById("loginUsername");
    const passwordInput = document.getElementById("loginPassword");
    const message = document.getElementById("loginMessage");

    const loginId = loginInput.value.trim();
    const password = passwordInput.value;

    const validation = validateLoginId(loginId);
    if(validation){
        message.textContent = validation;
        return;
    }
    if(!password){
        message.textContent = "パスワードを入力してください";
        return;
    }

    message.textContent = "ログイン中...";

    try{
        const authEmail = makeAuthEmail(loginId);

        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email: authEmail,
            password: password
        });

        if(error){ throw error; }
        if(!data || !data.user){
            throw new Error("ログインユーザーを取得できませんでした");
        }

        currentAuthUser = data.user;

        const profile = await loadProfile(currentAuthUser);
        if(!profile){
            throw new Error("プロフィール情報を取得できませんでした（先にWeb版でアカウント登録・ユーザー情報保存を行ってください）");
        }

        message.textContent = "";
        showApp();

        socketUserId = await resolveSocketUserId();
        await registerSocketUser();
    }
    catch(error){
        console.error("ログインエラー:", error);
        message.textContent = "ログインに失敗しました：" + (error.message || error);
    }
}

/* ==================================================
   プロフィール取得
================================================== */

async function loadProfile(user){
    if(!user){ return null; }

    const { data, error } = await supabaseClient
        .from("profiles")
        .select("user_id,display_name,icon_type,login_id")
        .eq("user_id", user.id)
        .maybeSingle();

    if(error){
        console.error("プロフィール取得エラー:", error);
        return null;
    }
    if(!data){
        console.warn("プロフィールが存在しません");
        return null;
    }

    const nameInput = document.getElementById("displayName");
    if(nameInput){
        nameInput.value = data.display_name || "";
    }

    localStorage.setItem("puttan_display_name", data.display_name || "");

    return data;
}

/* ==================================================
   Socket用ユーザーID解決（Web版と同じくSupabase AuthのUUIDを使用）
================================================== */

async function resolveSocketUserId(){
    if(socketUserId){ return socketUserId; }

    if(currentAuthUser && currentAuthUser.id){
        socketUserId = currentAuthUser.id;
        localStorage.setItem("puttan_user_id", socketUserId);
        return socketUserId;
    }

    return null;
}

/* ==================================================
   ログアウト
================================================== */

async function logoutUser(){
    if(!confirm("ログアウトしますか？")){
        return;
    }

    stopGps();
    registered = false;

    if(socketUserId){
        socket.emit("userOffline", socketUserId);
    }

    try{
        await supabaseClient.auth.signOut();
    }
    catch(error){
        console.error("ログアウトエラー:", error);
    }

    currentAuthUser = null;
    socketUserId = null;

    document.getElementById("loginUsername").value = "";
    document.getElementById("loginPassword").value = "";
    showAuth();
}

/* ==================================================
   Socket側ユーザー登録
   （Web版のregisterUserと同じイベント。水/燃料/物資は
     このアプリでは扱わないため未指定＝サーバー側で0扱い）
================================================== */

function registerSocketUser(){
    return new Promise(resolve => {
        if(!currentAuthUser || !socketUserId){
            resolve(false);
            return;
        }

        const nameInput = document.getElementById("displayName");
        const name = nameInput ? nameInput.value.trim() : "";
        if(!name){
            resolve(false);
            return;
        }

        const timeout = setTimeout(() => {
            socket.off("registerUserResult", resultHandler);
            registered = true;
            updateGpsStatusLabel();
            initPushNotifications();
            resolve(true);
        }, 5000);

        function resultHandler(result){
            clearTimeout(timeout);
            socket.off("registerUserResult", resultHandler);

            if(result && result.success){
                registered = true;
                updateGpsStatusLabel();
                initPushNotifications();
                resolve(true);
            }
            else{
                registered = false;
                console.error("Socketユーザー登録エラー:", result && result.message);
                resolve(false);
            }
        }

        socket.once("registerUserResult", resultHandler);

        socket.emit("registerUser", {
            user_id: socketUserId,
            display_name: name,
            account_name: name,
            icon: "1"
        });
    });
}

function saveDisplayName(){
    const nameInput = document.getElementById("displayName");
    const name = nameInput ? nameInput.value.trim() : "";
    if(!name){
        alert("表示名を入力してください");
        return;
    }

    localStorage.setItem("puttan_display_name", name);
    registerSocketUser();
}

/* ==================================================
   GPS 開始/停止
   ・現時点ではフォアグラウンド（navigator.geolocation）で動作。
   ・window.Capacitor.Plugins.BackgroundGeolocation が利用可能に
     なり次第（フェーズ3でネイティブプラグインを組み込んだ後）、
     startBackgroundTracking() の中身をそちらに差し替える。
================================================== */

function toggleGps(){
    if(gpsRunning){
        stopGps();
    }
    else{
        startGps();
    }
}

async function startGps(){
    if(!currentAuthUser){
        alert("先にログインしてください");
        return;
    }

    if(!registered){
        const ok = await registerSocketUser();
        if(!ok){
            alert("ユーザー登録に失敗しました。表示名を確認してください。");
            return;
        }
    }

    if(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundGeolocation){
        // フェーズ3: ネイティブのバックグラウンド位置情報プラグインを使用
        startBackgroundTracking();
    }
    else{
        // プラグイン未組み込み時のフォールバック（フォアグラウンドのみ）
        startForegroundTracking();
    }

    gpsRunning = true;
    localStorage.setItem("puttan_gps_running", "true");
    updateGpsToggleButton();
}

function stopGps(){
    if(watchID !== null){
        navigator.geolocation.clearWatch(watchID);
        watchID = null;
    }
    if(gpsTimer !== null){
        clearInterval(gpsTimer);
        gpsTimer = null;
    }

    if(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundGeolocation){
        stopBackgroundTracking();
    }

    lastLat = 0;
    lastLon = 0;
    lastSendTime = 0;
    gpsRunning = false;

    localStorage.removeItem("puttan_gps_running");
    updateGpsToggleButton();
    updateGpsStatusLabel();
}

function updateGpsToggleButton(){
    const button = document.getElementById("gpsToggleButton");
    if(button){
        button.textContent = gpsRunning ? "GPS停止" : "GPS開始";
    }
}

function updateGpsStatusLabel(){
    const status = document.getElementById("gpsStatus");
    if(!status){ return; }

    if(!gpsRunning){
        status.textContent = "🔴 停止中";
    }
    else if(!registered){
        status.textContent = "🟡 登録待ち";
    }
    else{
        status.textContent = "🟢 送信中";
    }
}

/* ==================================================
   フォアグラウンド位置情報取得（Web版と同じ間引きロジック）
================================================== */

function startForegroundTracking(){
    if(watchID !== null){ return; }

    // 高精度GPSの初回測位を待たず、キャッシュ/大まかな位置で即座に仮送信する
    navigator.geolocation.getCurrentPosition(
        pos => sendLocation(pos.coords.latitude, pos.coords.longitude),
        err => console.log("初回位置取得エラー（概略）:", err),
        { enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 }
    );

    gpsTimer = setInterval(() => {
        navigator.geolocation.getCurrentPosition(
            pos => sendLocation(pos.coords.latitude, pos.coords.longitude),
            err => console.log("GPSタイマーエラー:", err),
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    }, SEND_INTERVAL);

    watchID = navigator.geolocation.watchPosition(
        pos => {
            const lat = pos.coords.latitude;
            const lon = pos.coords.longitude;

            if(lastLat === 0){
                sendLocation(lat, lon);
                lastLat = lat;
                lastLon = lon;
                lastSendTime = Date.now();
                return;
            }

            const distance = getDistance(lastLat, lastLon, lat, lon);
            const now = Date.now();

            if(distance >= MOVE_DISTANCE || now - lastSendTime >= SEND_INTERVAL){
                sendLocation(lat, lon);
                lastLat = lat;
                lastLon = lon;
                lastSendTime = now;
            }
        },
        err => {
            console.log("GPSエラー:", err);
            const status = document.getElementById("gpsStatus");
            if(status){ status.textContent = "🔴 GPSエラー"; }
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );

    updateGpsStatusLabel();
}

/* ==================================================
   プッシュ通知（クロノロジー投稿の通知）
   ・@capacitor/push-notifications + Firebase Cloud Messaging
   ・画面OFF・アプリ終了中でもFCMのnotificationペイロードは
     OSが自動でバナー表示するため、アプリ側は端末トークンを
     取得してサーバーへ送るだけでよい
================================================== */

async function initPushNotifications(){
    if(pushNotificationsInitialized){ return; }

    const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
    if(!plugin){ return; }

    pushNotificationsInitialized = true;

    try{
        // requestPermissions()/register() が呼ばれた時点で既に権限許可済みだと
        // ネイティブ側がその場でregistrationイベントを発火することがあるため、
        // リスナーは必ず先に登録しておく
        await plugin.addListener("registration", token => {
            if(socketUserId && token && token.value){
                socket.emit("registerPushToken", { user_id: socketUserId, token: token.value });
            }
        });

        await plugin.addListener("registrationError", error => {
            console.error("プッシュ通知登録エラー:", error);
        });

        const permStatus = await plugin.requestPermissions();
        if(permStatus.receive !== "granted"){
            console.warn("プッシュ通知の権限が許可されませんでした");
            return;
        }

        // デフォルトチャンネルは重要度が低く、画面ロック中はバナー表示されず
        // 通知トレイのアイコンだけになるため、高重要度の専用チャンネルを作る
        await plugin.createChannel({
            id: "chronology",
            name: "クロノロジー通知",
            description: "クロノロジー投稿の通知",
            importance: 5,
            visibility: 1,
            vibration: true
        });

        await plugin.register();
    }
    catch(error){
        console.error("プッシュ通知の初期化に失敗:", error);
        pushNotificationsInitialized = false;
    }
}

/* ==================================================
   バックグラウンド位置情報取得
   ・@transistorsoft/capacitor-background-geolocation
   ・バンドラーを使っていないため、パッケージ同梱のラッパー
     クラス(BackgroundGeolocation.ready()等)は読み込めない。
     代わりにCapacitorが自動注入するネイティブブリッジ
     window.Capacitor.Plugins.BackgroundGeolocation を直接呼ぶ。
     メソッド名・Config項目は node_modules 内の型定義
     (@transistorsoft/background-geolocation-types) を実際に
     読んで確認したもの。実機での動作確認はまだ行っていない。
================================================== */

let bgLocationListener = null;
let bgProviderChangeListener = null;
let bgMotionChangeListener = null;
let bgHeartbeatListener = null;

function getBgGeoPlugin(){
    return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundGeolocation;
}

async function startBackgroundTracking(){
    const plugin = getBgGeoPlugin();
    if(!plugin){
        console.warn("BackgroundGeolocationプラグインが見つかりません — フォアグラウンド方式にフォールバックします");
        startForegroundTracking();
        return;
    }

    try{
        bgLocationListener = await plugin.addListener("location", location => {
            const coords = location && location.coords;
            if(coords){
                sendLocation(coords.latitude, coords.longitude);
            }
        });

        // 静止中は distanceFilter 未達で "location" イベントが発火しないため、
        // motionchange(静止⇔移動の切り替わり)とheartbeat(静止中の定期通知)でも送信する
        bgMotionChangeListener = await plugin.addListener("motionchange", event => {
            const coords = event && event.location && event.location.coords;
            if(coords){
                sendLocation(coords.latitude, coords.longitude);
            }
        });

        bgHeartbeatListener = await plugin.addListener("heartbeat", event => {
            const coords = event && event.location && event.location.coords;
            if(coords){
                sendLocation(coords.latitude, coords.longitude);
            }
        });

        bgProviderChangeListener = await plugin.addListener("providerchange", () => {
            checkBackgroundPermission();
        });

        const nameInput = document.getElementById("displayName");
        const name = nameInput ? nameInput.value.trim() : "";

        // ネイティブ側(BackgroundGeolocationPlugin.java の ready/reset/setConfig)は
        // call.getObject("options") で設定を取り出す実装のため、
        // 素のオブジェクトではなく { options: {...} } でラップして渡す必要がある
        await plugin.ready({
            options: {
                reset: true,
                desiredAccuracy: -1, // DesiredAccuracy.High
                distanceFilter: MOVE_DISTANCE,
                stopOnTerminate: false,
                startOnBoot: true,
                locationAuthorizationRequest: "Always",
                heartbeatInterval: SEND_INTERVAL / 1000, // 静止中もこの間隔(秒)でheartbeatイベントは出るが、
                                                          // heartbeatは前回位置のキャッシュ再送のためHTTP自動送信の対象にならない。
                                                          // 実際に定期送信させるには下記でstationary検出を無効化し、
                                                          // 一定間隔で"新しい"位置情報として記録・送信させる必要がある
                disableStopDetection: true, // 静止してもGPS取得を止めない(heartbeatのみの状態にしない)
                allowIdenticalLocations: true, // 移動していなくても定期取得した位置を記録・送信対象にする
                locationUpdateInterval: SEND_INTERVAL, // 位置取得間隔(ms)をSEND_INTERVALに合わせる
                // 画面OFF中はWebView(JS)が休止しSocket.IO送信が止まるため、
                // ネイティブ側から直接サーバーへPOSTする(WebViewの状態に依存しない)
                url: SERVER_URL + "/api/mobile-location",
                method: "POST",
                autoSync: true,
                logLevel: 5, // Verbose（adb logcatでHTTP送信の成否を確認するため）
                extras: {
                    user_id: socketUserId,
                    display_name: name,
                    device_id: getDeviceId()
                },
                notification: {
                    title: "Puttan",
                    text: "位置情報を送信中です"
                }
            }
        });

        await plugin.start();

        checkBackgroundPermission();
        requestBatteryOptimizationExemption();
    }
    catch(error){
        console.error("バックグラウンド位置情報の開始に失敗:", error);
        startForegroundTracking();
    }
}

// 端末のバッテリー最適化が有効なままだと、画面OFF中にOSが位置情報の
// 取得自体を間引いてしまい、GPS送信が止まる。初回のみ、除外を許可する
// システムダイアログをユーザーに直接表示する
async function requestBatteryOptimizationExemption(){
    const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BatteryOptimization;
    if(!plugin){ return; }

    if(localStorage.getItem("puttan_battery_opt_prompted") === "true"){
        return;
    }

    try{
        const state = await plugin.isIgnoringBatteryOptimizations();
        if(state && state.ignoring){
            localStorage.setItem("puttan_battery_opt_prompted", "true");
            return;
        }

        alert("画面OFF中も位置情報を送信し続けるため、次の画面で「許可」を選んでください。\n(バッテリー最適化の対象から外します)");
        await plugin.requestIgnoreBatteryOptimizations();
        localStorage.setItem("puttan_battery_opt_prompted", "true");
    }
    catch(error){
        console.error("バッテリー最適化除外リクエストに失敗:", error);
    }
}

async function stopBackgroundTracking(){
    const plugin = getBgGeoPlugin();
    if(!plugin){ return; }

    try{
        await plugin.stop();
    }
    catch(error){
        console.error("バックグラウンド位置情報の停止に失敗:", error);
    }

    if(bgLocationListener){
        bgLocationListener.remove();
        bgLocationListener = null;
    }
    if(bgProviderChangeListener){
        bgProviderChangeListener.remove();
        bgProviderChangeListener = null;
    }
    if(bgMotionChangeListener){
        bgMotionChangeListener.remove();
        bgMotionChangeListener = null;
    }
    if(bgHeartbeatListener){
        bgHeartbeatListener.remove();
        bgHeartbeatListener = null;
    }
}

async function checkBackgroundPermission(){
    const plugin = getBgGeoPlugin();
    const warning = document.getElementById("backgroundWarning");
    if(!plugin || !warning){ return; }

    try{
        const state = await plugin.getState();
        // AuthorizationStatus: NotDetermined:0, Restricted:1, Denied:2, Always:3, WhenInUse:4
        const isAlways = state && state.authorizationStatus === 3;
        warning.style.display = isAlways ? "none" : "block";
    }
    catch(error){
        console.error("権限状態の取得に失敗:", error);
    }
}

function openAppSettings(){
    if(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App && window.Capacitor.Plugins.App.openSettings){
        window.Capacitor.Plugins.App.openSettings();
    }
    else{
        alert("端末の設定アプリからPuttanの位置情報権限を「常に許可」に変更してください。");
    }
}

/* ==================================================
   GPS送信
================================================== */

function sendLocation(lat, lon){
    if(!currentAuthUser || !registered || !socketUserId){ return; }
    if(!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))){ return; }

    lat = Number(lat);
    lon = Number(lon);

    const utm = proj4(
        "EPSG:4326",
        "+proj=utm +zone=52 +south +datum=WGS84",
        [lon, lat]
    );

    const nameInput = document.getElementById("displayName");
    const name = nameInput ? nameInput.value.trim() : "";

    const lastSend = document.getElementById("lastSend");
    if(lastSend){
        lastSend.textContent = "最終送信：" + new Date().toLocaleTimeString("ja-JP", { hour12: false });
    }

    updateGpsStatusLabel();

    socket.emit("location", {
        user_id: socketUserId,
        display_name: name,
        lat: lat,
        lon: lon,
        utmZone: "52S",
        utmE: Math.round(utm[0]),
        utmN: Math.round(utm[1]),
        iconType: "1",
        device_id: getDeviceId()
    });
}

function getDeviceId(){
    let deviceId = localStorage.getItem("puttan_device_id");
    if(!deviceId){
        deviceId = "android-" + crypto.randomUUID();
        localStorage.setItem("puttan_device_id", deviceId);
    }
    return deviceId;
}

function getDistance(lat1, lon1, lat2, lon2){
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;

    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ==================================================
   ユーザー一覧受信（地図は無いが、リアクションの表示名解決に使う）
================================================== */

socket.on("locations", data => {
    if(data && typeof data === "object"){
        latestUsersData = data;
    }
});

// サーバー側は毎回全員分ではなく、更新があった1人分だけをこちらで配信する
socket.on("locationUpdate", payload => {
    if(payload && payload.userId && payload.user){
        latestUsersData[payload.userId] = payload.user;
    }
});

socket.on("announcement", () => { /* このアプリでは使用しない */ });

/* ==================================================
   クロノロジー
================================================== */

const REACTION_EMOJIS = ["👍", "🙇‍♂️", "🙆‍♂️", "🙅‍♂️", "🤷‍♂️", "🫶", "🍙", "🐈"];

socket.on("chronology", data => {
    chronology = Array.isArray(data) ? data : [];
    renderChronology();
});

function sendChronology(){
    if(!currentAuthUser){
        alert("先にログインしてください");
        return;
    }

    const element = document.getElementById("chronoMessage");
    const msg = element.value.trim();
    if(msg === ""){ return; }

    const category = document.getElementById("chronoCategory").value;
    const remarks = document.getElementById("chronoRemarks").value.trim();
    const nameInput = document.getElementById("displayName");

    socket.emit("addChronology", {
        message: msg,
        user: nameInput ? nameInput.value.trim() : "",
        category: category,
        remarks: remarks
    });

    element.value = "";
    document.getElementById("chronoRemarks").value = "";
}

function renderReactionSummary(item){
    const reactions = item.reactions || {};

    const chips = REACTION_EMOJIS
        .filter(emoji => (reactions[emoji] || []).length > 0)
        .map(emoji => {
            const users = reactions[emoji] || [];
            const mine = socketUserId && users.includes(socketUserId);

            return `
                <button class="reactionButton ${mine ? "reactionMine" : ""}"
                        onclick="event.stopPropagation(); toggleReaction(${item.id}, '${emoji}')">
                    ${emoji}<span class="reactionCount">${users.length}</span>
                </button>
            `;
        })
        .join("");

    if(!chips){ return ""; }

    return `<div class="reactionSummary">${chips}</div>`;
}

function renderReactionPicker(item){
    const reactions = item.reactions || {};

    const buttons = REACTION_EMOJIS.map(emoji => {
        const mine = socketUserId && (reactions[emoji] || []).includes(socketUserId);

        return `
            <button class="reactionButton ${mine ? "reactionMine" : ""}"
                    onclick="event.stopPropagation(); toggleReaction(${item.id}, '${emoji}')">
                ${emoji}
            </button>
        `;
    }).join("");

    return `<div class="reactionPicker" id="reactionPicker-${item.id}">${buttons}</div>`;
}

function renderChronologyItem(item){
    const remarksLine = item.remarks
        ? `<div class="timelineRemarks">📝 ${escapeHtml(item.remarks)}</div>`
        : "";

    const tapToReact = item.id ? `onclick="toggleReactionPicker(${item.id})"` : "";
    const idAttr = item.id ? `data-chronology-id="${item.id}"` : "";

    return `
        <div class="timelineItem" ${idAttr} ${tapToReact}>
            <div class="timelineHeader">
                <span>
                    <span class="timelineCategory ${item.category === "緊急" ? "catUrgent" : ""}">
                        ${escapeHtml(item.category || "その他")}
                    </span>
                    <span class="timelineSender">${escapeHtml(item.user || "-")}</span>
                </span>
                <span>${escapeHtml(item.time || "")}</span>
            </div>
            <div class="timelineMessage">${escapeHtml(item.message || "")}</div>
            ${remarksLine}
            ${renderReactionSummary(item)}
            ${item.id ? renderReactionPicker(item) : ""}
        </div>
    `;
}

function toggleReaction(chronologyId, emoji){
    if(!socketUserId){
        alert("先にログインしてください");
        return;
    }
    socket.emit("toggleReaction", { chronologyId: chronologyId, emoji: emoji, userId: socketUserId });
}

function toggleReactionPicker(chronologyId){
    const picker = document.getElementById(`reactionPicker-${chronologyId}`);
    if(picker){ picker.classList.toggle("open"); }
}

socket.on("chronologyReactionUpdate", data => {
    if(!data || !data.chronologyId){ return; }

    [chronology, olderChronology].forEach(list => {
        const item = list.find(i => i.id === data.chronologyId);
        if(item){ item.reactions = data.reactions || {}; }
    });

    renderChronology();
});

function renderChronology(){
    let html = "";

    chronology.forEach(item => { html += renderChronologyItem(item); });
    olderChronology.forEach(item => { html += renderChronologyItem(item); });

    html += chronologyExhausted
        ? `<div class="chronoLoadMoreDone">これ以上の過去ログはありません</div>`
        : `<button id="chronoLoadMoreButton" class="secondaryButton" onclick="loadMoreChronology(this)">もっと見る</button>`;

    const timeline = document.getElementById("timeline");
    if(timeline){
        timeline.innerHTML = html;
    }

    wireChronologyLongPress();
}

function loadMoreChronology(button){
    const allItems = chronology.concat(olderChronology);
    const oldest = allItems[allItems.length - 1];

    if(!oldest){ return; }

    if(button){
        button.disabled = true;
        button.textContent = "読み込み中...";
    }

    socket.emit("loadMoreChronology", { beforeId: oldest.id }, response => {
        if(!response || !response.success){
            if(button){
                button.disabled = false;
                button.textContent = "もっと見る";
            }
            alert("過去ログの取得に失敗しました");
            return;
        }

        if(response.items.length === 0){
            chronologyExhausted = true;
        }
        else{
            olderChronology = olderChronology.concat(response.items);
        }

        renderChronology();
    });
}

/* ==================================================
   長押しでリアクション詳細（誰が押したか）を表示
================================================== */

function wireChronologyLongPress(){
    document.querySelectorAll(".timelineItem[data-chronology-id]").forEach(el => {
        let pressTimer = null;
        let longPressed = false;

        const start = () => {
            longPressed = false;
            pressTimer = setTimeout(() => {
                longPressed = true;
                showReactionDetail(Number(el.dataset.chronologyId));
            }, 500);
        };

        const cancel = () => {
            if(pressTimer){
                clearTimeout(pressTimer);
                pressTimer = null;
            }
        };

        el.addEventListener("mousedown", start);
        el.addEventListener("touchstart", start, { passive: true });
        el.addEventListener("mouseup", cancel);
        el.addEventListener("mouseleave", cancel);
        el.addEventListener("touchend", cancel);
        el.addEventListener("touchmove", cancel);

        el.addEventListener("click", event => {
            if(longPressed){
                event.stopPropagation();
                event.preventDefault();
                longPressed = false;
            }
        }, true);
    });
}

function showReactionDetail(chronologyId){
    const item = chronology.concat(olderChronology).find(i => i.id === chronologyId);
    if(!item){ return; }

    const reactions = item.reactions || {};
    const rows = REACTION_EMOJIS
        .filter(emoji => (reactions[emoji] || []).length > 0)
        .map(emoji => {
            const names = reactions[emoji].map(userId => {
                const user = latestUsersData[userId];
                return escapeHtml(user ? (user.display_name || user.name || userId) : userId);
            }).join("、");

            return `
                <div class="reactionDetailRow">
                    <span class="reactionDetailEmoji">${emoji}</span>
                    <span class="reactionDetailNames">${names}</span>
                </div>
            `;
        })
        .join("");

    const body = document.getElementById("reactionDetailBody");
    if(body){
        body.innerHTML = rows || `<div class="reactionDetailEmpty">まだリアクションはありません</div>`;
    }

    const overlay = document.getElementById("reactionDetailOverlay");
    if(overlay){ overlay.classList.add("active"); }
}

function closeReactionDetail(){
    const overlay = document.getElementById("reactionDetailOverlay");
    if(overlay){ overlay.classList.remove("active"); }
}

/* ==================================================
   Socket接続・再接続
================================================== */

socket.on("connect", async () => {
    console.log("サーバー接続");

    if(currentAuthUser && socketUserId && registered){
        await registerSocketUser();
    }
});

/* ==================================================
   起動時のセッション復元
================================================== */

window.addEventListener("load", async () => {
    try{
        const { data, error } = await supabaseClient.auth.getSession();

        if(error || !data || !data.session || !data.session.user){
            showAuth();
            return;
        }

        currentAuthUser = data.session.user;

        const profile = await loadProfile(currentAuthUser);
        if(!profile){
            await supabaseClient.auth.signOut();
            showAuth();
            return;
        }

        showApp();

        socketUserId = await resolveSocketUserId();
        await registerSocketUser();

        if(localStorage.getItem("puttan_gps_running") === "true"){
            startGps();
        }
    }
    catch(error){
        console.error("起動処理エラー:", error);
        showAuth();
    }
});

supabaseClient.auth.onAuthStateChange((event) => {
    if(event === "SIGNED_OUT"){
        currentAuthUser = null;
        socketUserId = null;
        registered = false;
        showAuth();
    }
});
