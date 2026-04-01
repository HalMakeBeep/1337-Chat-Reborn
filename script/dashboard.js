const BASE_URL = "https://one337-chat-reborn-server.onrender.com/";

const token = localStorage.getItem("token");
if (!token) window.location.href = "./index.html";

const urlParams = new URLSearchParams(window.location.search);
const userId = urlParams.get("id");
if (!userId) window.location.href = "./index.html";

let userSettings = { theme: "purple", fontSize: "medium", notifications: true, readReceipts: true };
let friendsList = [];
let chatSummaries = [];
let groupSummaries = [];
let pendingFriendRequestCount = 0;
let currentChatUserId = null;
let currentGroupId = null;
let isCurrentGroupLoading = false;
let activeDmProfile = null;
let activeGroupProfile = null;
let lastDmReadContext = { dmUserId: null, canMarkRead: false };
let lastGroupReadContext = { groupId: null, canMarkRead: false };
const bufferedGroupMessages = {};
const renderedGroupMessageIds = {};
let chatSummaryRefreshTimeout = null;
let groupSummaryRefreshTimeout = null;

// --------------- Auth Fetch ---------------
async function authFetch(url, options = {}) {
    options.headers = { ...options.headers, Authorization: `Bearer ${token}` };
    const res = await fetch(url, options);
    if (res.status === 401 || res.status === 403) {
        localStorage.removeItem("token");
        window.location.href = "./index.html";
        throw new Error("Session expired");
    }
    return res;
}

// --------------- Socket.io ---------------
const socket = io(BASE_URL, { auth: { token } });

socket.on("connect_error", (err) => {
    console.error("Socket connection failed:", err.message);
    if (err.message.includes("Authentication") || err.message.includes("token") || err.message.includes("revoked")) {
        localStorage.removeItem("token");
        window.location.href = "./index.html";
    }
});

socket.on("disconnect", () => {
    let banner = document.getElementById("reconnect-banner");
    if (!banner) {
        banner = document.createElement("div");
        banner.id = "reconnect-banner";
        banner.className = "reconnect-banner";
        banner.innerHTML = '<i class="fa-solid fa-wifi"></i> Reconnecting...';
        document.body.prepend(banner);
    }
    banner.classList.remove("hidden");
});

socket.on("connect", () => {
    const banner = document.getElementById("reconnect-banner");
    if (banner) banner.classList.add("hidden");
    lastDmReadContext = { dmUserId: null, canMarkRead: false };
    lastGroupReadContext = { groupId: null, canMarkRead: false };
    syncReadContext(true);
    loadChatSummaries();
    loadGroups();
    loadFriends();
});

// --------------- DOM References ---------------
const searchBtn = document.getElementById("searchBtn");
const query = document.getElementById("query");
const search_users_list = document.getElementById("search_users_list");
const search_users_list_container = document.getElementById("search_users_list_container");
const users_list = document.getElementsByClassName("users_list")[0];
const activeUserName = document.getElementById("profile_name");
const profile_pic = document.getElementById("profile_pic");
const logout = document.getElementById("logout");
const sidebar = document.getElementById("sidebar");
const usersProfile = document.getElementById("usersProfile");
const openAddFriendModalBtn = document.getElementById("openAddFriendModal");
const addFriendModal = document.getElementById("addFriendModal");
const closeAddFriendBtn = document.getElementById("closeAddFriend");
const friendSearchInput = document.getElementById("friendSearchInput");
const friendSearchBtn = document.getElementById("friendSearchBtn");
const friendSearchResults = document.getElementById("friendSearchResults");
const friendSearchHint = document.getElementById("friendSearchHint");
const chatsTabBadge = document.getElementById("chatsTabBadge");
const friendsTabBadge = document.getElementById("friendsTabBadge");
const groupsTabBadge = document.getElementById("groupsTabBadge");
const sentFriendRequestIds = new Set();
const EMPTY_CHAT_PANEL_HTML = usersProfile.innerHTML;

function isDmPanelVisible() {
    if (!currentChatUserId) return false;
    if (window.innerWidth > 768) return true;
    return usersProfile.classList.contains("chat-visible");
}

function canMarkCurrentDmRead() {
    return Boolean(
        userSettings.readReceipts
        && currentChatUserId
        && document.visibilityState === "visible"
        && document.hasFocus()
        && isDmPanelVisible()
    );
}

function isGroupPanelVisible() {
    if (!currentGroupId) return false;
    if (window.innerWidth > 768) return true;
    return usersProfile.classList.contains("chat-visible");
}

function canMarkCurrentGroupRead() {
    return Boolean(
        currentGroupId
        && document.visibilityState === "visible"
        && document.hasFocus()
        && isGroupPanelVisible()
    );
}

function syncDmReadContext(force = false) {
    const canMarkRead = canMarkCurrentDmRead();
    const payload = {
        dmUserId: canMarkRead ? currentChatUserId : null,
        canMarkRead,
    };

    if (!socket.connected) return;

    if (
        force
        || payload.dmUserId !== lastDmReadContext.dmUserId
        || payload.canMarkRead !== lastDmReadContext.canMarkRead
    ) {
        socket.emit("setReadContext", payload);
        lastDmReadContext = payload;
    }

    if (payload.canMarkRead && payload.dmUserId) {
        socket.emit("markRead", payload.dmUserId);
    }
}

function syncGroupReadContext(force = false) {
    const canMarkRead = canMarkCurrentGroupRead();
    const payload = {
        groupId: canMarkRead ? currentGroupId : null,
        canMarkRead,
    };

    if (!socket.connected) return;

    if (
        force
        || payload.groupId !== lastGroupReadContext.groupId
        || payload.canMarkRead !== lastGroupReadContext.canMarkRead
    ) {
        socket.emit("setGroupReadContext", payload);
        lastGroupReadContext = payload;
    }

    if (payload.canMarkRead && payload.groupId) {
        socket.emit("markGroupRead", payload.groupId);
    }
}

function syncReadContext(force = false) {
    syncDmReadContext(force);
    syncGroupReadContext(force);
}

window.addEventListener("focus", () => syncReadContext());
window.addEventListener("blur", () => syncReadContext());
window.addEventListener("resize", () => syncReadContext());
document.addEventListener("visibilitychange", () => syncReadContext());

// --------------- Receipt Helpers ---------------
let pendingQueue = [];
const pendingStatusBuffer = {};
const STATUS_PRIORITY = { sent: 0, delivered: 1, read: 2 };

function receiptHTML(status) {
    if (status === "read") {
        return '<i class="fa-solid fa-check"></i><i class="fa-solid fa-check"></i>';
    }
    if (status === "delivered") {
        return '<i class="fa-solid fa-check"></i><i class="fa-solid fa-check"></i>';
    }
    return '<i class="fa-solid fa-check"></i><i class="fa-solid fa-check faded"></i>';
}

function receiptIcon(status) {
    return `<span class="msg-status ${status || "sent"}">${receiptHTML(status)}</span>`;
}

function applyStatusToEl(el, status) {
    el.className = `msg-status ${status}`;
    el.innerHTML = receiptHTML(status);
}

function updateReceiptStatus(msgIds, status) {
    msgIds.forEach((id) => {
        const el = document.querySelector(`[data-msg-id="${id}"] .msg-status`);
        if (el) {
            applyStatusToEl(el, status);
        } else {
            const existing = pendingStatusBuffer[id];
            if (!existing || STATUS_PRIORITY[status] > STATUS_PRIORITY[existing]) {
                pendingStatusBuffer[id] = status;
            }
        }
    });
}

function ensureGroupMessageState(groupId) {
    if (!bufferedGroupMessages[groupId]) bufferedGroupMessages[groupId] = [];
    if (!renderedGroupMessageIds[groupId]) renderedGroupMessageIds[groupId] = new Set();
}

function normalizeGroupMessage(message) {
    return {
        _id: message._id ? message._id.toString() : null,
        groupId: message.groupId ? message.groupId.toString() : null,
        senderId: message.senderId ? message.senderId.toString() : null,
        senderName: message.senderName || "",
        message: message.message,
        createdAt: message.createdAt || new Date().toISOString(),
    };
}

function getGroupMessageList(groupId) {
    return document.getElementById("group-" + groupId);
}

function appendGroupMessage(message, options = {}) {
    const normalized = normalizeGroupMessage(message);
    const targetGroupId = normalized.groupId || options.groupId || currentGroupId;
    if (!targetGroupId) return false;

    ensureGroupMessageState(targetGroupId);
    if (normalized._id) {
        const renderedIds = renderedGroupMessageIds[targetGroupId];
        if (renderedIds.has(normalized._id)) {
            return true;
        }
        renderedIds.add(normalized._id);
    }

    const ul = getGroupMessageList(targetGroupId);
    if (!ul) return false;

    const isMine = options.isMine === true || normalized.senderId === userId;
    const li = document.createElement("li");
    li.className = isMine ? "send" : "receive group-receive";

    if (!isMine) {
        const senderSpan = document.createElement("span");
        senderSpan.className = "msg-sender";
        senderSpan.textContent = normalized.senderName;
        senderSpan.style.color = nameColor(normalized.senderId);
        li.append(senderSpan);
    }

    const msgSpan = document.createElement("span");
    msgSpan.className = "msg-text";
    msgSpan.textContent = normalized.message;

    const timeSpan = document.createElement("span");
    timeSpan.className = "msg-time";
    timeSpan.textContent = new Date(normalized.createdAt).toLocaleTimeString([], { timeStyle: "short" });

    li.append(msgSpan, timeSpan);
    ul.append(li);
    ul.scrollTop = ul.scrollHeight;
    return true;
}

function bufferGroupMessage(message) {
    const normalized = normalizeGroupMessage(message);
    const groupId = normalized.groupId;
    if (!groupId) return;

    ensureGroupMessageState(groupId);
    if (normalized._id) {
        if (renderedGroupMessageIds[groupId].has(normalized._id)) return;
        if (bufferedGroupMessages[groupId].some((msg) => msg._id === normalized._id)) return;
    }

    bufferedGroupMessages[groupId].push(normalized);
}

function flushBufferedGroupMessages(groupId) {
    ensureGroupMessageState(groupId);
    const pendingMessages = bufferedGroupMessages[groupId];
    bufferedGroupMessages[groupId] = [];
    pendingMessages.forEach((message) => appendGroupMessage(message, { groupId }));
}

function loadGroupMessages(groupId) {
    ensureGroupMessageState(groupId);
    renderedGroupMessageIds[groupId] = new Set();
    isCurrentGroupLoading = true;

    return authFetch(`${BASE_URL}/group/messages?groupId=${groupId}`)
        .then((r) => r.json())
        .then((messages) => {
            if (currentGroupId !== groupId) return;

            const ul = getGroupMessageList(groupId);
            if (!ul) return;

            ul.innerHTML = "";
            messages.forEach((message) => appendGroupMessage(message, { groupId }));
            flushBufferedGroupMessages(groupId);
        })
        .catch((error) => console.error("Failed to load group messages:", error))
        .finally(() => {
            if (currentGroupId === groupId) {
                isCurrentGroupLoading = false;
                syncReadContext();
            }
        });
}

function formatBadgeCount(count) {
    if (count > 99) return "99+";
    return String(count);
}

function setBadgeCount(element, count) {
    if (!element) return;
    if (count > 0) {
        element.textContent = formatBadgeCount(count);
        element.classList.remove("hidden");
    } else {
        element.textContent = "0";
        element.classList.add("hidden");
    }
}

function formatSummaryTime(timestamp) {
    if (!timestamp) return "";

    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "";

    const now = new Date();
    const isToday = now.toDateString() === date.toDateString();
    return isToday
        ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
        : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function truncatePreview(text, maxLength = 60) {
    if (!text) return "";
    return text.length > maxLength ? text.slice(0, maxLength - 1) + "…" : text;
}

function updateTabBadges() {
    setBadgeCount(
        chatsTabBadge,
        chatSummaries.reduce((total, summary) => total + (summary.unreadCount || 0), 0)
    );
    setBadgeCount(friendsTabBadge, pendingFriendRequestCount);
    setBadgeCount(
        groupsTabBadge,
        groupSummaries.reduce((total, group) => total + (group.unreadCount || 0), 0)
    );
}

function updateActiveListSelections() {
    document.querySelectorAll(".chat-list-item").forEach((item) => {
        item.classList.toggle("active", item.dataset.userId === currentChatUserId);
    });
    document.querySelectorAll(".group-card").forEach((item) => {
        item.classList.toggle("active", item.dataset.groupId === currentGroupId);
    });
}

function scheduleChatSummariesRefresh(delay = 0) {
    if (chatSummaryRefreshTimeout) clearTimeout(chatSummaryRefreshTimeout);
    chatSummaryRefreshTimeout = setTimeout(() => {
        chatSummaryRefreshTimeout = null;
        loadChatSummaries();
    }, delay);
}

function scheduleGroupSummariesRefresh(delay = 0) {
    if (groupSummaryRefreshTimeout) clearTimeout(groupSummaryRefreshTimeout);
    groupSummaryRefreshTimeout = setTimeout(() => {
        groupSummaryRefreshTimeout = null;
        loadGroups();
    }, delay);
}

function resetChatPanel() {
    currentChatUserId = null;
    currentGroupId = null;
    activeDmProfile = null;
    activeGroupProfile = null;
    isCurrentGroupLoading = false;
    pendingQueue = [];
    usersProfile.innerHTML = EMPTY_CHAT_PANEL_HTML;
    sidebar.classList.remove("sidebar-hidden");
    usersProfile.classList.remove("chat-visible");
    updateActiveListSelections();
    syncReadContext(true);
}

function getChatSummaryByUserId(targetUserId) {
    return chatSummaries.find((summary) => summary.contact && summary.contact._id === targetUserId) || null;
}

function getGroupSummaryById(groupId) {
    return groupSummaries.find((group) => group._id === groupId) || null;
}

function openDmConversation(user) {
    return authFetch(`${BASE_URL}/user/getAllMessages?user2=${user._id}`)
        .then((r) => r.json())
        .then((messages) => openProfile(user, user._id, messages));
}

function createDmMessageElement(message, type) {
    const li = document.createElement("li");
    if (message._id) li.setAttribute("data-msg-id", message._id);
    li.className = type;

    const timestamp = new Date(message.timestamp || message.createdAt || new Date().toISOString());
    const time = timestamp.toLocaleTimeString([], { timeStyle: "short" });
    const msgSpan = document.createElement("span");
    msgSpan.className = "msg-text";
    msgSpan.textContent = message.message;

    const timeSpan = document.createElement("span");
    timeSpan.className = "msg-time";
    if (type === "send") {
        timeSpan.innerHTML = time + " " + receiptIcon(message.status);
    } else {
        timeSpan.textContent = time;
    }

    li.append(msgSpan, timeSpan);
    return li;
}

function clearChatSearchResults() {
    search_users_list.innerHTML = "";
    search_users_list_container.classList.remove("has-results");
}

function showChatSearchResults() {
    search_users_list_container.classList.add("has-results");
}

function resetFriendSearchModal(message = "Search for users to send a friend request.") {
    friendSearchResults.innerHTML = "";
    friendSearchHint.textContent = message;
    friendSearchHint.classList.remove("hidden");
}

function openAddFriendModal() {
    friendSearchInput.value = "";
    resetFriendSearchModal();
    addFriendModal.classList.remove("hidden");
    friendSearchInput.focus();
}

function closeAddFriendModal() {
    addFriendModal.classList.add("hidden");
    friendSearchInput.value = "";
    resetFriendSearchModal();
}

function sendFriendRequest(targetUserId, button) {
    return authFetch(`${BASE_URL}/friend/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: targetUserId }),
    }).then(async (r) => ({ ok: r.ok, body: await r.json() })).then(({ ok, body }) => {
        if (!ok || body.error) {
            throw new Error(body.error || "Failed to send friend request");
        }

        sentFriendRequestIds.add(targetUserId);
        if (button) {
            button.textContent = "Sent!";
            button.disabled = true;
        }
    }).catch((error) => console.error("Friend request failed:", error.message));
}

function buildAddFriendButton(el) {
    const addBtn = document.createElement("button");
    addBtn.className = "action-btn-sm accent";

    const isFriend = friendsList.some((f) => f._id === el._id);
    if (isFriend) {
        addBtn.textContent = "Friends";
        addBtn.disabled = true;
        return addBtn;
    }

    if (sentFriendRequestIds.has(el._id)) {
        addBtn.textContent = "Sent!";
        addBtn.disabled = true;
        return addBtn;
    }

    addBtn.textContent = "Add Friend";
    addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        sendFriendRequest(el._id, addBtn);
    });
    return addBtn;
}

function renderFriendSearchResults(users) {
    friendSearchResults.innerHTML = "";

    if (users.length === 0) {
        resetFriendSearchModal("No users found.");
        return;
    }

    friendSearchHint.classList.add("hidden");
    users.forEach((el) => {
        const div = document.createElement("div");
        div.className = "users_list_container modal-user-result";

        const img = document.createElement("img");
        img.src = el.picture;
        img.style.width = "50px";
        img.style.height = "50px";

        const info = document.createElement("div");
        info.className = "search-user-info";

        const name = document.createElement("span");
        name.textContent = el.name;
        info.append(name);

        const actions = document.createElement("div");
        actions.className = "search-actions";
        actions.append(buildAddFriendButton(el));

        div.append(img, info, actions);
        friendSearchResults.append(div);
    });
}

function runFriendSearch() {
    const search = friendSearchInput.value.trim();
    if (!search) {
        resetFriendSearchModal();
        return;
    }

    authFetch(`${BASE_URL}/user/searchUser?search=${encodeURIComponent(search)}`)
        .then((r) => r.json())
        .then((response) => renderFriendSearchResults(response));
}

socket.on("msgDelivered", (msgIds) => updateReceiptStatus(msgIds, "delivered"));
socket.on("msgRead", (msgIds) => updateReceiptStatus(msgIds, "read"));
socket.on("msgSent", (msgId, status) => {
    const pending = pendingQueue.shift();
    if (!pending) return;

    if (pending._sendTimeout) clearTimeout(pending._sendTimeout);
    pending.setAttribute("data-msg-id", msgId);

    const buffered = pendingStatusBuffer[msgId];
    delete pendingStatusBuffer[msgId];

    let finalStatus = status || "sent";
    if (buffered && STATUS_PRIORITY[buffered] > STATUS_PRIORITY[finalStatus]) {
        finalStatus = buffered;
    }

    const statusEl = pending.querySelector(".msg-status");
    if (statusEl) {
        applyStatusToEl(statusEl, finalStatus);
    }
});

// --------------- Receive Messages (DM) ---------------
socket.on("receivedMsg", (payload, fallbackSenderId) => {
    const normalized = typeof payload === "object" && payload !== null
        ? payload
        : {
            message: payload,
            senderId: fallbackSenderId,
            createdAt: new Date().toISOString(),
            sender: null,
        };

    const senderId = normalized.senderId ? normalized.senderId.toString() : null;
    if (!senderId) return;

    scheduleChatSummariesRefresh(40);

    if (currentChatUserId !== senderId) return;

    const ul = document.getElementById(senderId);
    if (!ul) return;

    ul.append(createDmMessageElement(normalized, "receive"));
    ul.scrollTop = ul.scrollHeight;
    syncReadContext();
});

socket.on("chatsUpdated", () => scheduleChatSummariesRefresh(40));

// --------------- Logout ---------------
logout.addEventListener("click", async () => {
    try { await authFetch(`${BASE_URL}/user/logout`); } catch (e) {}
    localStorage.removeItem("token");
    window.location.href = "./index.html";
});

// --------------- Load Initial Data ---------------
authFetch(`${BASE_URL}/user/settings`)
    .then((r) => r.json())
    .then((response) => {
        activeUserName.textContent = response.name;
        profile_pic.src = response.picture;
        if (response.settings) {
            userSettings = { ...userSettings, ...response.settings };
            applySettings();
        }
    })
    .catch((err) => console.error("Failed to load settings:", err));

loadChatSummaries();
loadFriends();
loadGroups();

// --------------- Open DM Chat ---------------
function openProfile(el, data_id, msg) {
    currentChatUserId = data_id;
    currentGroupId = null;
    isCurrentGroupLoading = false;
    activeDmProfile = el;
    activeGroupProfile = null;
    pendingQueue = [];
    usersProfile.innerHTML = "";

    const nav = document.createElement("nav");
    nav.setAttribute("id", "usersHeader");
    const img = document.createElement("img");
    img.src = el.picture;
    img.style.width = "40px";
    img.style.height = "40px";
    const name = document.createElement("span");
    name.innerText = el.name;

    const div = document.createElement("div");
    div.setAttribute("id", "usersChat");
    const ul = document.createElement("ul");
    ul.setAttribute("id", data_id);

    if (msg !== undefined && Array.isArray(msg)) {
        msg.forEach(({ data, type }) => {
            ul.append(createDmMessageElement(data, type));
        });
    }

    const footer = document.createElement("footer");
    footer.setAttribute("id", "usersFooter");
    footer.style.bottom = "0";
    footer.style.left = "0";
    footer.style.width = "100%";
    const input = document.createElement("input");
    input.setAttribute("type", "text");
    input.setAttribute("maxlength", "5000");
    const button = document.createElement("button");
    button.innerHTML = '<i class="fa-sharp fa-solid fa-paper-plane"></i>';
    input.placeholder = "Chat to " + el.name + "...";

    button.addEventListener("click", () => sendMessage(el, input, ul));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") sendMessage(el, input, ul); });

    nav.append(img, name);
    div.append(ul);
    footer.append(input, button);
    usersProfile.append(nav, div, footer);
    ul.scrollTop = ul.scrollHeight;

    // Mobile handling
    if (window.innerWidth <= 768) {
        sidebar.classList.add("sidebar-hidden");
        usersProfile.classList.add("chat-visible");
        if (!nav.querySelector(".back-btn")) {
            const backBtn = document.createElement("button");
            backBtn.className = "back-btn";
            backBtn.innerHTML = '<i class="fa-solid fa-arrow-left"></i>';
            backBtn.addEventListener("click", () => {
                sidebar.classList.remove("sidebar-hidden");
                usersProfile.classList.remove("chat-visible");
                syncReadContext();
            });
            nav.prepend(backBtn);
        }
    }

    updateActiveListSelections();
    syncReadContext(true);
}

// --------------- Chat Summaries ---------------
function loadChatSummaries() {
    return authFetch(`${BASE_URL}/user/chatSummaries`)
        .then((r) => r.json())
        .then((summaries) => {
            chatSummaries = Array.isArray(summaries) ? summaries : [];
            renderChatSummaries();
        })
        .catch((error) => console.error("Failed to load chat summaries:", error));
}

function renderChatSummaries() {
    users_list.innerHTML = "";

    if (chatSummaries.length === 0) {
        const empty = document.createElement("li");
        empty.className = "list-empty-state";
        empty.textContent = "No chats yet. Start a conversation from search.";
        users_list.append(empty);
        updateTabBadges();
        return;
    }

    chatSummaries.forEach((summary) => {
        const user = summary.contact;
        if (!user) return;

        const li = document.createElement("li");
        li.className = "users_list_item chat-list-item";
        li.dataset.userId = user._id;

        const img = document.createElement("img");
        img.src = user.picture;
        img.setAttribute("width", "50px");
        img.setAttribute("height", "50px");

        const body = document.createElement("div");
        body.className = "conversation-meta";

        const topRow = document.createElement("div");
        topRow.className = "conversation-top";

        const name = document.createElement("p");
        name.className = "conversation-name";
        name.textContent = user.name;

        const time = document.createElement("span");
        time.className = "conversation-time";
        time.textContent = formatSummaryTime(summary.lastMessageAt);

        topRow.append(name, time);

        const bottomRow = document.createElement("div");
        bottomRow.className = "conversation-bottom";

        const preview = document.createElement("span");
        preview.className = "conversation-preview";
        preview.textContent = truncatePreview(summary.lastMessage || "No messages yet.");

        const badge = document.createElement("span");
        badge.className = "item-badge";
        if ((summary.unreadCount || 0) > 0) {
            badge.textContent = formatBadgeCount(summary.unreadCount);
        } else {
            badge.classList.add("hidden");
            badge.textContent = "0";
        }

        bottomRow.append(preview, badge);
        body.append(topRow, bottomRow);

        li.addEventListener("click", () => openDmConversation(user));

        li.append(img, body);
        users_list.append(li);
    });

    updateActiveListSelections();
    updateTabBadges();
}

// --------------- Search Users ---------------
searchBtn.addEventListener("click", () => {
    const search = query.value.trim();
    if (!search) {
        clearChatSearchResults();
        return;
    }

    authFetch(`${BASE_URL}/user/searchUser?search=${encodeURIComponent(search)}`)
        .then((r) => r.json())
        .then((response) => renderSearchUsers(response));
});

query.addEventListener("keydown", (e) => { if (e.key === "Enter") searchBtn.click(); });
query.addEventListener("input", () => {
    if (!query.value.trim()) {
        clearChatSearchResults();
    }
});

function renderSearchUsers(users) {
    search_users_list.innerHTML = "";
    showChatSearchResults();

    if (users.length === 0) {
        const hint = document.createElement("p");
        hint.className = "empty-hint search-empty-hint";
        hint.textContent = "No users found.";
        search_users_list.append(hint);
        return;
    }

    users.forEach((el) => {
        const div = document.createElement("div");
        div.setAttribute("class", "users_list_container");

        const img = document.createElement("img");
        img.src = el.picture;
        img.style.width = "50px";
        img.style.height = "50px";

        const info = document.createElement("div");
        info.className = "search-user-info";
        const name = document.createElement("span");
        name.textContent = el.name;
        info.append(name);

        const actions = document.createElement("div");
        actions.className = "search-actions";

        const msgBtn = document.createElement("button");
        msgBtn.className = "action-btn-sm";
        msgBtn.textContent = "Message";
        msgBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            query.value = "";
            clearChatSearchResults();
            openDmConversation(el);
        });
        actions.append(msgBtn);

        actions.append(buildAddFriendButton(el));

        div.append(img, info, actions);
        search_users_list.append(div);
    });
}

// --------------- Send Message ---------------
function sendMessage(el, input, ul) {
    const msg = input.value.trim();
    if (msg.length === 0) return;

    const li = document.createElement("li");
    li.setAttribute("data-msg-id", "pending-" + Date.now());
    const time = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
    li.className = "send";
    const msgSpan = document.createElement("span");
    msgSpan.className = "msg-text";
    msgSpan.textContent = msg;
    const timeSpan = document.createElement("span");
    timeSpan.className = "msg-time";
    timeSpan.innerHTML = time + ' <span class="msg-status sending"><i class="fa-regular fa-clock"></i></span>';
    li.append(msgSpan, timeSpan);
    ul.append(li);
    pendingQueue.push(li);

    li._sendTimeout = setTimeout(() => {
        const statusEl = li.querySelector(".msg-status");
        if (statusEl && statusEl.classList.contains("sending")) {
            statusEl.className = "msg-status failed";
            statusEl.innerHTML = '<i class="fa-solid fa-exclamation-circle"></i>';
        }
    }, 8000);

    socket.emit("chatMsg", msg, el._id);
    input.value = "";
    input.placeholder = "Chat to " + el.name + "...";
    ul.scrollTop = ul.scrollHeight;
}

// =====================================================
//  SIDEBAR TABS
// =====================================================
document.querySelectorAll(".sidebar-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
        document.querySelectorAll(".sidebar-tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        document.querySelectorAll(".tab-content").forEach((tc) => tc.classList.add("hidden"));
        document.getElementById("tab-" + tab.dataset.tab).classList.remove("hidden");

        if (tab.dataset.tab === "friends") loadFriends();
        if (tab.dataset.tab === "groups") loadGroups();
    });
});

// =====================================================
//  FRIENDS
// =====================================================
function loadFriends() {
    authFetch(`${BASE_URL}/friend/list`).then((r) => r.json()).then((friends) => {
        friendsList = friends;
        renderFriendsList(friends);
    });
    authFetch(`${BASE_URL}/friend/requests`).then((r) => r.json()).then((requests) => {
        renderFriendRequests(requests);
    });
}

function renderFriendRequests(requests) {
    pendingFriendRequestCount = requests.length;
    updateTabBadges();
    const container = document.getElementById("friend-requests-list");
    container.innerHTML = "";
    if (requests.length === 0) {
        container.innerHTML = '<p class="empty-hint">No pending requests</p>';
        return;
    }
    requests.forEach((req) => {
        const div = document.createElement("div");
        div.className = "friend-request-card";
        const img = document.createElement("img");
        img.src = req.from.picture;
        img.width = 40; img.height = 40;
        const name = document.createElement("span");
        name.textContent = req.from.name;
        const actions = document.createElement("div");
        actions.className = "fr-actions";
        const acceptBtn = document.createElement("button");
        acceptBtn.className = "action-btn-sm accent";
        acceptBtn.textContent = "Accept";
        acceptBtn.addEventListener("click", () => {
            authFetch(`${BASE_URL}/friend/accept`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ requestId: req._id }),
            }).then(() => loadFriends());
        });
        const declineBtn = document.createElement("button");
        declineBtn.className = "action-btn-sm";
        declineBtn.textContent = "Decline";
        declineBtn.addEventListener("click", () => {
            authFetch(`${BASE_URL}/friend/decline`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ requestId: req._id }),
            }).then(() => loadFriends());
        });
        actions.append(acceptBtn, declineBtn);
        div.append(img, name, actions);
        container.append(div);
    });
}

function renderFriendsList(friends) {
    const container = document.getElementById("friends-list");
    container.innerHTML = "";
    if (friends.length === 0) {
        container.innerHTML = '<p class="empty-hint">No friends yet. Search for users to add!</p>';
        return;
    }
    friends.forEach((f) => {
        const div = document.createElement("div");
        div.className = "friend-card";
        const img = document.createElement("img");
        img.src = f.picture;
        img.width = 42; img.height = 42;
        const name = document.createElement("span");
        name.textContent = f.name;
        const actions = document.createElement("div");
        actions.className = "fr-actions";
        const msgBtn = document.createElement("button");
        msgBtn.className = "action-btn-sm";
        msgBtn.textContent = "Message";
        msgBtn.addEventListener("click", () => {
            document.querySelector('[data-tab="chats"]').click();
            openDmConversation(f);
        });
        const removeBtn = document.createElement("button");
        removeBtn.className = "action-btn-sm danger";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", () => {
            authFetch(`${BASE_URL}/friend/remove`, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId: f._id }),
            }).then(() => loadFriends());
        });
        actions.append(msgBtn, removeBtn);
        div.append(img, name, actions);
        container.append(div);
    });
}

socket.on("friendUpdate", () => loadFriends());

openAddFriendModalBtn.addEventListener("click", openAddFriendModal);
closeAddFriendBtn.addEventListener("click", closeAddFriendModal);
friendSearchBtn.addEventListener("click", runFriendSearch);
friendSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runFriendSearch();
});
friendSearchInput.addEventListener("input", () => {
    if (!friendSearchInput.value.trim()) {
        resetFriendSearchModal();
    }
});

// =====================================================
//  GROUPS
// =====================================================
function loadGroups() {
    authFetch(`${BASE_URL}/group/list`).then((r) => r.json()).then((groups) => {
        groupSummaries = Array.isArray(groups) ? groups : [];
        renderGroupsList(groupSummaries);

        if (currentGroupId && !getGroupSummaryById(currentGroupId)) {
            resetChatPanel();
        }
    });
}

function renderGroupsList(groups) {
    const container = document.getElementById("groups-list");
    container.innerHTML = "";
    updateTabBadges();
    if (groups.length === 0) {
        container.innerHTML = '<p class="empty-hint">No groups yet. Create one!</p>';
        return;
    }
    groups.forEach((g) => {
        const div = document.createElement("div");
        div.className = "group-card users_list_item";
        div.dataset.groupId = g._id;

        const img = document.createElement("img");
        img.src = g.picture;
        img.width = 46; img.height = 46;

        const info = document.createElement("div");
        info.className = "conversation-meta";

        const topRow = document.createElement("div");
        topRow.className = "conversation-top";

        const name = document.createElement("p");
        name.className = "conversation-name";
        name.textContent = g.name;

        const time = document.createElement("span");
        time.className = "conversation-time";
        time.textContent = formatSummaryTime(g.lastMessageAt);

        topRow.append(name, time);

        const bottomRow = document.createElement("div");
        bottomRow.className = "conversation-bottom";

        const preview = document.createElement("span");
        preview.className = "conversation-preview";
        preview.textContent = truncatePreview(
            g.lastMessage
                ? `${g.lastMessageSenderId === userId ? "You" : (g.lastMessageSenderName || "Member")}: ${g.lastMessage}`
                : `${g.members ? g.members.length : 0} members`
        );

        const badge = document.createElement("span");
        badge.className = "item-badge";
        if ((g.unreadCount || 0) > 0) {
            badge.textContent = formatBadgeCount(g.unreadCount);
        } else {
            badge.classList.add("hidden");
            badge.textContent = "0";
        }

        bottomRow.append(preview, badge);
        info.append(topRow, bottomRow);

        div.append(img, info);
        div.addEventListener("click", () => openGroupChat(g));
        container.append(div);
    });

    updateActiveListSelections();
}

// Create Group Modal
document.getElementById("createGroupBtn").addEventListener("click", () => {
    document.getElementById("createGroupModal").classList.remove("hidden");
    document.getElementById("groupNameInput").value = "";
    document.getElementById("groupPictureInput").value = "";
    const fList = document.getElementById("groupFriendsList");
    fList.innerHTML = "";
    friendsList.forEach((f) => {
        const label = document.createElement("label");
        label.className = "group-friend-check";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = f._id;
        cb.className = "custom-check-input";
        const indicator = document.createElement("span");
        indicator.className = "custom-check";
        const img = document.createElement("img");
        img.src = f.picture;
        img.width = 30; img.height = 30;
        const span = document.createElement("span");
        span.textContent = f.name;
        label.append(cb, indicator, img, span);
        fList.append(label);
    });
});

document.getElementById("closeCreateGroup").addEventListener("click", () => {
    document.getElementById("createGroupModal").classList.add("hidden");
});

document.getElementById("confirmCreateGroup").addEventListener("click", () => {
    const name = document.getElementById("groupNameInput").value.trim();
    if (!name) return;
    const picture = document.getElementById("groupPictureInput").value.trim();
    const checked = document.querySelectorAll("#groupFriendsList input:checked");
    const memberIds = Array.from(checked).map((cb) => cb.value);
    memberIds.push(userId);

    authFetch(`${BASE_URL}/group/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, picture: picture || undefined, memberIds }),
    }).then((r) => r.json()).then((group) => {
        document.getElementById("createGroupModal").classList.add("hidden");
        socket.emit("joinGroup", group._id);
        loadGroups();
    });
});

// Open Group Chat
function openGroupChat(group) {
    currentChatUserId = null;
    currentGroupId = group._id;
    activeDmProfile = null;
    activeGroupProfile = group;
    socket.emit("joinGroup", group._id);
    pendingQueue = [];
    syncReadContext(true);
    usersProfile.innerHTML = "";

    const nav = document.createElement("nav");
    nav.setAttribute("id", "usersHeader");
    const img = document.createElement("img");
    img.src = group.picture;
    img.style.width = "40px";
    img.style.height = "40px";
    const nameSpan = document.createElement("span");
    nameSpan.innerText = group.name;
    const memberCount = document.createElement("span");
    memberCount.className = "group-header-members";
    memberCount.textContent = (group.members ? group.members.length : 0) + " members";

    const div = document.createElement("div");
    div.setAttribute("id", "usersChat");
    const ul = document.createElement("ul");
    ul.setAttribute("id", "group-" + group._id);

    const footer = document.createElement("footer");
    footer.setAttribute("id", "usersFooter");
    footer.style.bottom = "0";
    footer.style.left = "0";
    footer.style.width = "100%";
    const input = document.createElement("input");
    input.setAttribute("type", "text");
    input.setAttribute("maxlength", "5000");
    input.placeholder = "Message " + group.name + "...";
    const button = document.createElement("button");
    button.innerHTML = '<i class="fa-sharp fa-solid fa-paper-plane"></i>';

    button.addEventListener("click", () => sendGroupMessage(group, input, ul));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") sendGroupMessage(group, input, ul); });

    nav.append(img, nameSpan, memberCount);
    div.append(ul);
    footer.append(input, button);
    usersProfile.append(nav, div, footer);

    // Mobile handling
    if (window.innerWidth <= 768) {
        sidebar.classList.add("sidebar-hidden");
        usersProfile.classList.add("chat-visible");
        if (!nav.querySelector(".back-btn")) {
            const backBtn = document.createElement("button");
            backBtn.className = "back-btn";
            backBtn.innerHTML = '<i class="fa-solid fa-arrow-left"></i>';
            backBtn.addEventListener("click", () => {
                sidebar.classList.remove("sidebar-hidden");
                usersProfile.classList.remove("chat-visible");
                syncReadContext();
            });
            nav.prepend(backBtn);
        }
    }

    updateActiveListSelections();
    loadGroupMessages(group._id);
}

function sendGroupMessage(group, input, ul) {
    const msg = input.value.trim();
    if (msg.length === 0) return;

    appendGroupMessage(
        {
            groupId: group._id,
            senderId: userId,
            message: msg,
            createdAt: new Date().toISOString(),
        },
        { isMine: true, groupId: group._id }
    );

    socket.emit("groupMsg", msg, group._id);
    input.value = "";
    if (ul) ul.scrollTop = ul.scrollHeight;
}

// Receive group messages
socket.on("groupMsgReceived", (data) => {
    const groupId = data.groupId ? data.groupId.toString() : null;
    if (!groupId) return;

    scheduleGroupSummariesRefresh(40);
    if (groupId !== currentGroupId) return;

    const ul = getGroupMessageList(groupId);
    if (isCurrentGroupLoading || !ul) {
        bufferGroupMessage(data);
        return;
    }

    appendGroupMessage(data, { groupId });
    syncReadContext();
});

socket.on("groupsUpdated", () => scheduleGroupSummariesRefresh(40));
socket.on("groupUpdated", () => scheduleGroupSummariesRefresh(40));

// Deterministic color from user ID
function nameColor(id) {
    const colors = ["#a855f7", "#3b82f6", "#10b981", "#ef4444", "#f59e0b", "#ec4899", "#14b8a6", "#f97316"];
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
}

// =====================================================
//  SETTINGS
// =====================================================
document.getElementById("settingsBtn").addEventListener("click", () => {
    document.getElementById("settingsModal").classList.remove("hidden");
    document.getElementById("settingsName").value = activeUserName.textContent;
    document.getElementById("settingsPicture").value = profile_pic.src;
    document.getElementById("settingsReadReceipts").checked = userSettings.readReceipts;
    document.getElementById("settingsNotifications").checked = userSettings.notifications;
    document.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("active", s.dataset.theme === userSettings.theme));
    document.querySelectorAll(".font-btn").forEach((b) => b.classList.toggle("active", b.dataset.size === userSettings.fontSize));
});

document.getElementById("closeSettings").addEventListener("click", () => {
    document.getElementById("settingsModal").classList.add("hidden");
});

document.getElementById("themeSwatches").addEventListener("click", (e) => {
    const swatch = e.target.closest(".swatch");
    if (!swatch) return;
    document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
    swatch.classList.add("active");
});

document.getElementById("fontSizeBtns").addEventListener("click", (e) => {
    const btn = e.target.closest(".font-btn");
    if (!btn) return;
    document.querySelectorAll(".font-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
});

document.getElementById("saveSettings").addEventListener("click", () => {
    const activeSwatch = document.querySelector(".swatch.active");
    const activeFont = document.querySelector(".font-btn.active");
    const payload = {
        name: document.getElementById("settingsName").value.trim(),
        picture: document.getElementById("settingsPicture").value.trim(),
        settings: {
            theme: activeSwatch ? activeSwatch.dataset.theme : userSettings.theme,
            fontSize: activeFont ? activeFont.dataset.size : userSettings.fontSize,
            readReceipts: document.getElementById("settingsReadReceipts").checked,
            notifications: document.getElementById("settingsNotifications").checked,
        },
    };

    authFetch(`${BASE_URL}/user/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then((r) => r.json()).then((updated) => {
        activeUserName.textContent = updated.name;
        profile_pic.src = updated.picture;
        userSettings = { ...userSettings, ...updated.settings };
        applySettings();
        document.getElementById("settingsModal").classList.add("hidden");
        syncReadContext(true);
    });
});

const themeMap = {
    purple: { accent: "#7b2fff", glow: "#a855f7", soft: "rgba(123, 47, 255, 0.15)", gradient: "linear-gradient(135deg, #7b2fff, #a855f7)" },
    blue:   { accent: "#3b82f6", glow: "#60a5fa", soft: "rgba(59, 130, 246, 0.15)", gradient: "linear-gradient(135deg, #3b82f6, #60a5fa)" },
    green:  { accent: "#10b981", glow: "#34d399", soft: "rgba(16, 185, 129, 0.15)", gradient: "linear-gradient(135deg, #10b981, #34d399)" },
    red:    { accent: "#ef4444", glow: "#f87171", soft: "rgba(239, 68, 68, 0.15)", gradient: "linear-gradient(135deg, #ef4444, #f87171)" },
};

function applySettings() {
    const t = themeMap[userSettings.theme] || themeMap.purple;
    const root = document.documentElement.style;
    root.setProperty("--accent", t.accent);
    root.setProperty("--accent-glow", t.glow);
    root.setProperty("--accent-soft", t.soft);
    root.setProperty("--sent-gradient", t.gradient);

    document.body.classList.remove("font-small", "font-medium", "font-large");
    document.body.classList.add("font-" + (userSettings.fontSize || "medium"));
}
