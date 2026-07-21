import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";
import { firebaseConfig } from "./firebase-config.js";

const DEFAULT_ROOM = { openHour: 9, closeHour: 23, slotMinutes: 60 };
const APP_VERSION = "20260721.7";
const LOGIN_ID_STORAGE_KEY = "soundcheck.loginId";
const state = {
  firebaseUser: null,
  loginId: null,
  profile: null,
  bands: [],
  directoryBands: [],
  pendingLogoDataUrl: null,
  reservations: [],
  announcements: [],
  room: DEFAULT_ROOM,
  unsubs: [],
};

const configMissing = Object.values(firebaseConfig).some((value) => String(value).includes("YOUR_"));
const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, "asia-northeast3");
const call = (name, data) => httpsCallable(functions, name)(data);

function requiredElement(id) {
  const element = elements[id] || document.getElementById(id);
  if (!element) throw new Error("화면 업데이트가 완전히 적용되지 않았습니다. 페이지를 새로고침해 주세요.");
  return element;
}

const LOGIN_ID_PATTERN = /^[가-힣a-z0-9_-]{2,12}$/i;

function normaliseLoginId(value) {
  const loginId = String(value || "").trim().normalize("NFC").toLocaleLowerCase("ko-KR");
  if (!LOGIN_ID_PATTERN.test(loginId)) {
    throw new Error("아이디는 한글·영문·숫자·밑줄·하이픈으로 2~12자까지 사용할 수 있습니다.");
  }
  return loginId;
}

function loginIdToAuthEmail(loginId) {
  const bytes = new TextEncoder().encode(loginId);
  const encoded = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `id-${encoded}@id.soundcheck.local`;
}

function rememberLoginId(value) {
  const loginId = normaliseLoginId(value);
  state.loginId = loginId;
  localStorage.setItem(LOGIN_ID_STORAGE_KEY, loginId);
  if (elements.activationLoginId) elements.activationLoginId.value = loginId;
  return loginId;
}

function forgetLoginId() {
  state.loginId = null;
  localStorage.removeItem(LOGIN_ID_STORAGE_KEY);
}

function loginIdFromCurrentUser() {
  const loginId = normaliseLoginId(state.loginId || elements.activationLoginId?.value || localStorage.getItem(LOGIN_ID_STORAGE_KEY));
  const email = auth.currentUser?.email || "";
  if (email.toLowerCase() !== loginIdToAuthEmail(loginId).toLowerCase()) {
    throw new Error("로그인한 아이디와 입력한 아이디가 다릅니다.");
  }
  return rememberLoginId(loginId);
}

let deferredInstallPrompt;

function setupAppInstall() {
  const button = elements.installAppButton;
  if (!button || window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone) return;

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIos) {
    button.classList.remove("hidden");
    button.addEventListener("click", () => showToast("Safari 공유 버튼에서 ‘홈 화면에 추가’를 선택하세요."));
    return;
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    button.classList.remove("hidden");
  });

  button.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    button.classList.add("hidden");
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}), { once: true });
}
function pad(value) {
  return String(value).padStart(2, "0");
}

function todayInSeoul() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateText, amount) {
  const date = new Date(`${dateText}T00:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function humanDate(dateText, withDay = false) {
  const date = new Date(`${dateText}T00:00:00+09:00`);
  return new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", ...(withDay ? { weekday: "short" } : {}) }).format(date);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

function formatFirestoreDate(value) {
  if (!value?.toDate) return "방금 전";
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }).format(value.toDate());
}

function showToast(message, error = false) {
  window.clearTimeout(showToast.timeout);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.classList.add("show");
  showToast.timeout = window.setTimeout(() => elements.toast.classList.remove("show"), 3900);
}

function errorMessage(error) {
  const messages = {
    "auth/invalid-credential": "아이디 또는 비밀번호가 맞지 않습니다.",
    "auth/email-already-in-use": "이미 사용 중인 아이디입니다. 로그인해 주세요.",
    "auth/weak-password": "비밀번호는 8자 이상으로 설정해 주세요.",
    "auth/user-not-found": "등록된 계정을 찾지 못했습니다.",
    "auth/invalid-email": "아이디 형식을 확인해 주세요.",
  };
  return messages[error?.code] || error?.message || "처리 중 문제가 발생했습니다. 다시 시도해 주세요.";
}

function setDialogView(view) {
  ["authView", "signupView", "activationView"].forEach((id) => elements[id].classList.toggle("hidden", id !== view));
}

function openAuth() {
  if (window.location.protocol === "file:") {
    showToast("로그인과 가입은 배포된 Soundcheck 웹주소에서만 사용할 수 있습니다.", true);
    return;
  }
  if (configMissing) {
    showToast("먼저 public/firebase-config.js에 Firebase 웹 설정을 입력해 주세요.", true);
    return;
  }
  if (state.firebaseUser && !state.profile) setDialogView("activationView");
  else setDialogView("authView");
  elements.authDialog.showModal();
}

function applyRoomToControls() {
  const { openHour, closeHour } = state.room;
  const timeOption = (hour) => `<option value="${hour}">${pad(hour)}:00</option>`;
  elements.startHour.innerHTML = Array.from({ length: closeHour - openHour }, (_, index) => timeOption(openHour + index)).join("");
  elements.endHour.innerHTML = Array.from({ length: closeHour - openHour }, (_, index) => timeOption(openHour + index + 1)).join("");
  elements.startHour.value = String(openHour);
  elements.endHour.value = String(Math.min(openHour + 1, closeHour));
  const allHours = Array.from({ length: 25 }, (_, index) => timeOption(index)).join("");
  elements.openHour.innerHTML = allHours;
  elements.closeHour.innerHTML = allHours;
  elements.openHour.value = String(openHour);
  elements.closeHour.value = String(closeHour);
  elements.heroOpenHour.textContent = `${pad(openHour)}:00`;
  elements.heroCloseHour.textContent = `${pad(closeHour)}:00`;
}

function renderNotices() {
  const notices = state.announcements;
  elements.noticeCount.textContent = notices.length ? `${notices.length}개의 안내` : "새 공지 없음";
  elements.noticeList.innerHTML = notices.length ? notices.map((notice) => `
    <article class="notice">
      <div><h3>${escapeHtml(notice.title)}</h3><p>${escapeHtml(notice.body)}</p></div>
      <time>${formatFirestoreDate(notice.publishedAt)}</time>
      ${state.profile?.role === "main_admin" ? `<button class="text-button notice-delete" data-delete-notice="${notice.id}">삭제</button>` : ""}
    </article>`).join("") : "<p class=\"empty-message\">등록된 공지사항이 없습니다.</p>";
}

function bandLogoMarkup(band, className = "band-card-logo") {
  if (band.logoDataUrl) {
    return `<img class="${className}" src="${escapeHtml(band.logoDataUrl)}" alt="${escapeHtml(band.name)} 로고" />`;
  }
  const initial = Array.from(String(band.name || "♪"))[0] || "♪";
  return `<span class="${className} band-logo-fallback" style="--band-color:${escapeHtml(band.color || "#8B5CF6")}">${escapeHtml(initial)}</span>`;
}

function visibleBands() {
  const source = state.bands.length ? state.bands : state.directoryBands;
  return source.filter((band) => band.active !== false).slice().sort((a, b) => String(a.name).localeCompare(String(b.name), "ko"));
}

function renderBandDirectory() {
  const bands = visibleBands();
  elements.bandCount.textContent = bands.length ? `${bands.length}팀` : "등록된 밴드 없음";
  elements.bandDirectory.innerHTML = bands.length ? bands.map((band) => `
    <article class="band-card" style="--band-color:${escapeHtml(band.color || "#8B5CF6")}">
      ${bandLogoMarkup(band)}
      <h3>${escapeHtml(band.name)}</h3>
    </article>`).join("") : "<p class=\"empty-message\">아직 등록된 밴드가 없습니다.</p>";
}

async function loadBandDirectory() {
  try {
    const result = await call("listBandDirectory");
    state.directoryBands = Array.isArray(result.data?.bands) ? result.data.bands : [];
    renderBandDirectory();
  } catch (error) {
    if (!state.bands.length) {
      elements.bandCount.textContent = "불러오기 실패";
      elements.bandDirectory.innerHTML = "<p class=\"empty-message\">밴드 목록을 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.</p>";
    }
  }
}
function publicReservationRange() {
  const from = elements.weekStart.value || todayInSeoul();
  return { from, to: addDays(from, 6) };
}

async function loadPublicReservations() {
  if (state.profile || configMissing) return;
  try {
    const result = await call("listPublicReservations", publicReservationRange());
    state.reservations = Array.isArray(result.data?.reservations) ? result.data.reservations : [];
    renderCalendar();
  } catch (error) {
    state.reservations = [];
    renderCalendar();
    showToast("예약 현황을 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.", true);
  }
}
function selectedLogoBand() {
  return state.bands.find((band) => band.id === elements.logoBand.value);
}
function selectedDeleteBand() {
  return state.bands.find((band) => band.id === elements.deleteBand.value);
}

function renderBandLogoPreview() {
  if (state.profile?.role !== "main_admin") return;
  const band = selectedLogoBand();
  if (!band) {
    elements.bandLogoPreview.innerHTML = "<span>NO LOGO</span>";
    return;
  }
  const previewBand = { ...band, logoDataUrl: state.pendingLogoDataUrl ?? band.logoDataUrl };
  elements.bandLogoPreview.innerHTML = bandLogoMarkup(previewBand, "band-logo-preview-image");
}
function renderCalendar() {
  const baseDate = elements.weekStart.value || todayInSeoul();
  const days = Array.from({ length: 7 }, (_, index) => addDays(baseDate, index));
  const slots = [];
  slots.push('<div class="calendar-corner"></div>');
  for (const day of days) {
    const isToday = day === todayInSeoul();
    slots.push(`<div class="day-head ${isToday ? "today" : ""}"><span>${humanDate(day, true).split(" ")[1] || ""}</span><strong>${humanDate(day)}</strong></div>`);
  }
  for (let hour = state.room.openHour; hour < state.room.closeHour; hour += 1) {
    slots.push(`<div class="time-label">${pad(hour)}:00</div>`);
    for (const day of days) {
      const reservation = state.reservations.find((item) => item.date === day && item.startHour <= hour && item.endHour > hour);
      if (!reservation) {
        slots.push(`<div class="calendar-slot" data-date="${day}" data-hour="${hour}"></div>`);
        continue;
      }
      const firstSlot = reservation.startHour === hour;
      const label = firstSlot ? `<span>${pad(reservation.startHour)}:00–${pad(reservation.endHour)}:00</span>${escapeHtml(reservation.bandName)}` : "";
      slots.push(`<div class="calendar-slot"><button class="calendar-booking" data-reservation-id="${reservation.id}" style="border-left-color:${escapeHtml(reservation.bandColor || "#C8F063")}">${label}</button></div>`);
    }
  }
  elements.calendarWrap.innerHTML = `<div class="calendar">${slots.join("")}</div>`;
}

function renderMyReservations() {
  if (!state.profile) return;
  const reservations = state.reservations.filter((reservation) => state.profile.role === "main_admin" || reservation.bandId === state.profile.bandId);
  elements.myReservationCount.textContent = `${reservations.length}건`;
  elements.myReservationList.innerHTML = reservations.length ? reservations.map((reservation) => `
    <article class="my-reservation" style="--reservation-color:${escapeHtml(reservation.bandColor || "#7957E8")}">
      <strong>${escapeHtml(reservation.bandName)}</strong>
      <p>${humanDate(reservation.date)} · ${pad(reservation.startHour)}:00–${pad(reservation.endHour)}:00</p>
      <button class="cancel-button" data-cancel-reservation="${reservation.id}">예약 취소</button>
    </article>`).join("") : "<p class=\"empty-message\">예정된 예약이 없습니다.</p>";
}

function renderBands() {
  renderBandDirectory();
  if (state.profile?.role !== "main_admin") return;
  const activeBands = state.bands.filter((band) => band.active);
  const reservationValue = elements.reservationBand.value;
  const logoValue = elements.logoBand.value;
  const deleteValue = elements.deleteBand.value;
  const options = activeBands.map((band) => `<option value="${band.id}">${escapeHtml(band.name)}</option>`).join("");
  elements.reservationBand.innerHTML = options;
  elements.logoBand.innerHTML = options;
  elements.deleteBand.innerHTML = options || "<option value="">삭제할 밴드 없음</option>";
  if (activeBands.some((band) => band.id === reservationValue)) elements.reservationBand.value = reservationValue;
  if (activeBands.some((band) => band.id === logoValue)) elements.logoBand.value = logoValue;
  if (activeBands.some((band) => band.id === deleteValue)) elements.deleteBand.value = deleteValue;
  renderBandLogoPreview();
}

function renderProfile() {
  const profile = state.profile;
  const isBandAdmin = profile?.role === "band_admin";
  if (isBandAdmin) document.querySelector("main").prepend(elements.memberArea);
  else elements.memberAreaAnchor.after(elements.memberArea);
  elements.memberArea.classList.toggle("member-area-priority", isBandAdmin);
  const isActive = Boolean(profile);
  elements.profileChip.classList.toggle("hidden", !isActive);
  elements.signOutButton.classList.toggle("hidden", !state.firebaseUser);
  const needsActivation = Boolean(state.firebaseUser && !profile);
  elements.openAuthButton.classList.toggle("hidden", Boolean(state.firebaseUser && profile));
  elements.openAuthButton.textContent = needsActivation ? "권한 활성화" : "로그인 / 시작";
  elements.memberArea.classList.toggle("hidden", !isActive);
  elements.adminArea.classList.toggle("hidden", profile?.role !== "main_admin");
  elements.reservationBandField.classList.toggle("hidden", profile?.role !== "main_admin");
  if (!profile) {
    renderNotices();
    return;
  }
  const roleText = profile.role === "main_admin" ? "메인 관리자" : "밴드 관리자";
  elements.profileChip.textContent = `${profile.displayName} · ${roleText}`;
  elements.memberDescription.textContent = profile.role === "main_admin" ? "모든 밴드의 일정을 확인하고, 필요하면 대리 예약과 취소를 할 수 있습니다." : "내 밴드의 합주 시간을 예약하거나 취소할 수 있습니다.";
  renderBands();
  renderMyReservations();
  renderNotices();
}

function clearAppSubscriptions() {
  state.unsubs.forEach((unsubscribe) => unsubscribe());
  state.unsubs = [];
  state.bands = [];
  state.reservations = [];
  renderBandDirectory();
}

function subscribeToAppData() {
  clearAppSubscriptions();
  const from = elements.weekStart.value || todayInSeoul();
  const to = addDays(from, 6);
  state.unsubs.push(onSnapshot(collection(db, "bands"), (snapshot) => {
    state.bands = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    renderBands();
  }, (error) => showToast(errorMessage(error), true)));
  const reservationQuery = query(collection(db, "reservations"), where("status", "==", "confirmed"), where("date", ">=", from), where("date", "<=", to), orderBy("date"), orderBy("startHour"));
  state.unsubs.push(onSnapshot(reservationQuery, (snapshot) => {
    state.reservations = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    renderCalendar();
    renderMyReservations();
  }, (error) => showToast(errorMessage(error), true)));
}

async function refreshProfile() {
  if (!auth.currentUser) {
    state.profile = null;
    return;
  }
  const snapshot = await getDoc(doc(db, "users", auth.currentUser.uid));
  const profile = snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
  state.profile = profile?.active === false ? null : profile;
}

function subscribeToPublicData() {
  loadBandDirectory();
  loadPublicReservations();
  onSnapshot(query(collection(db, "announcements"), where("active", "==", true), orderBy("publishedAt", "desc")), (snapshot) => {
    state.announcements = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    renderNotices();
  }, () => {
    elements.noticeList.innerHTML = "<p class=\"empty-message\">공지사항을 불러올 수 없습니다.</p>";
  });
  onSnapshot(doc(db, "settings", "room"), (snapshot) => {
    state.room = snapshot.exists() ? { ...DEFAULT_ROOM, ...snapshot.data() } : DEFAULT_ROOM;
    applyRoomToControls();
    renderCalendar();
  });
}

async function showReservationOverview() {
  if (state.profile) {
    elements.memberArea.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  await loadPublicReservations();
  elements.schedule.scrollIntoView({ behavior: "smooth", block: "start" });
  showToast("시간표에서 예약된 날짜와 시간을 확인할 수 있습니다.");
}

function showReservation(id) {
  const reservation = state.reservations.find((item) => item.id === id);
  if (!reservation) return;
  elements.reservationDialogTitle.textContent = reservation.bandName;
  elements.reservationDialogInfo.textContent = `${humanDate(reservation.date, true)} ${pad(reservation.startHour)}:00부터 ${pad(reservation.endHour)}:00까지 예약되어 있습니다.`;
  elements.reservationDialog.showModal();
}

async function handleReservation(event) {
  event.preventDefault();
  if (!state.profile) return openAuth();
  const startHour = Number(elements.startHour.value);
  const endHour = Number(elements.endHour.value);
  if (endHour <= startHour) return showToast("종료 시간은 시작 시간보다 뒤여야 합니다.", true);
  try {
    await call("createReservation", {
      date: elements.reservationDate.value,
      startHour,
      endHour,
      ...(state.profile.role === "main_admin" ? { bandId: elements.reservationBand.value } : {}),
    });
    showToast("예약이 완료되었습니다.");
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}

async function handleLogin(event) {
  event.preventDefault();
  try {
    const loginId = normaliseLoginId(elements.loginId.value);
    await signInWithEmailAndPassword(auth, loginIdToAuthEmail(loginId), elements.loginPassword.value);
    rememberLoginId(loginId);
    await refreshProfile();
    renderProfile();
    if (!state.profile) {
      setDialogView("activationView");
      showToast("계정은 만들어졌습니다. 초대 코드 또는 초기 관리자 코드로 권한을 활성화하세요.");
      return;
    }
    subscribeToAppData();
    elements.authDialog.close();
    showToast("로그인했습니다.");
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}
async function handleSignup(event) {
  event.preventDefault();
  try {
    const loginId = normaliseLoginId(requiredElement("signupId").value);
    await createUserWithEmailAndPassword(auth, loginIdToAuthEmail(loginId), requiredElement("signupPassword").value);
    rememberLoginId(loginId);
    const inviteCode = requiredElement("signupInviteCode").value.trim();
    if (!inviteCode) {
      elements.signupForm.reset();
      setDialogView("activationView");
      showToast("계정이 만들어졌습니다. 초기 관리자 코드를 입력해 권한을 활성화하세요.");
      return;
    }
    await call("claimBandInvite", { displayName: requiredElement("signupName").value.trim(), code: inviteCode, loginId });
    await refreshProfile();
    renderProfile();
    elements.authDialog.close();
    showToast("밴드 관리자 계정이 활성화되었습니다.");
  } catch (error) {
    if (auth.currentUser && !state.profile) await auth.currentUser.reload();
    showToast(errorMessage(error), true);
  }
}
async function handleClaimInvite(event) {
  event.preventDefault();
  try {
    await call("claimBandInvite", { displayName: elements.claimName.value.trim(), code: elements.claimInviteCode.value.trim(), loginId: loginIdFromCurrentUser() });
    await refreshProfile();
    renderProfile();
    subscribeToAppData();
    elements.authDialog.close();
    showToast("밴드 관리자 권한이 활성화되었습니다.");
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}

async function handleBootstrap(event) {
  event.preventDefault();
  try {
    await call("bootstrapMainAdmin", { displayName: elements.bootstrapName.value.trim(), code: elements.bootstrapCode.value, loginId: loginIdFromCurrentUser() });
    await refreshProfile();
    renderProfile();
    subscribeToAppData();
    elements.authDialog.close();
    showToast("메인 관리자 권한이 활성화되었습니다.");
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}

async function handleBandCreate(event) {
  event.preventDefault();
  try {
    const result = await call("createBand", { name: elements.bandName.value.trim(), managerLoginId: normaliseLoginId(elements.managerId.value) });
    const expires = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Seoul" }).format(new Date(result.data.expiresAt));
    elements.inviteResult.innerHTML = `<strong>${escapeHtml(result.data.code)}</strong><p><b>${escapeHtml(elements.bandName.value.trim())}</b> 관리자에게 이 코드를 전달하세요. ${expires}까지 한 번만 사용할 수 있습니다.</p>`;
    elements.inviteResult.classList.remove("hidden");
    elements.bandForm.reset();
    showToast("밴드를 추가하고 초대 코드를 만들었습니다.");
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}

function loadLogoImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("이미지 파일을 읽을 수 없습니다."));
    };
    image.src = url;
  });
}

async function prepareBandLogo(file) {
  if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("PNG·JPG·WebP 이미지 파일을 선택해 주세요.");
  }
  if (file.size > 5 * 1024 * 1024) throw new Error("로고 원본은 5MB 이하로 선택해 주세요.");
  const image = await loadLogoImage(file);
  const drawLogo = (maxSize, type, quality, background = "") => {
    const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (background) {
      context.fillStyle = background;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL(type, quality);
  };
  let dataUrl = drawLogo(480, "image/webp", 0.82);
  if (dataUrl.length > 340000) dataUrl = drawLogo(360, "image/webp", 0.7);
  if (dataUrl.length > 340000) dataUrl = drawLogo(360, "image/jpeg", 0.7, "#ffffff");
  if (dataUrl.length > 340000) throw new Error("이미지를 더 작은 크기로 줄인 뒤 다시 선택해 주세요.");
  return dataUrl;
}

function applyBandLogoLocally(bandId, logoDataUrl) {
  for (const list of [state.bands, state.directoryBands]) {
    const band = list.find((item) => item.id === bandId);
    if (band) band.logoDataUrl = logoDataUrl;
  }
  state.pendingLogoDataUrl = null;
  elements.bandLogoFile.value = "";
  renderBands();
}

async function handleBandLogoFile(event) {
  const [file] = event.target.files;
  if (!file) return;
  try {
    state.pendingLogoDataUrl = await prepareBandLogo(file);
    renderBandLogoPreview();
    showToast("로고 미리보기를 준비했습니다. 저장 버튼을 눌러 주세요.");
  } catch (error) {
    state.pendingLogoDataUrl = null;
    event.target.value = "";
    renderBandLogoPreview();
    showToast(errorMessage(error), true);
  }
}

async function handleBandLogoSubmit(event) {
  event.preventDefault();
  const band = selectedLogoBand();
  if (!band) return showToast("로고를 등록할 밴드를 선택해 주세요.", true);
  if (!state.pendingLogoDataUrl) return showToast("새 로고 이미지 파일을 선택해 주세요.", true);
  try {
    const logoDataUrl = state.pendingLogoDataUrl;
    await call("updateBandLogo", { bandId: band.id, logoDataUrl });
    applyBandLogoLocally(band.id, logoDataUrl);
    await loadBandDirectory();
    showToast(`${band.name} 로고를 저장했습니다.`);
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}

async function handleBandLogoRemove() {
  const band = selectedLogoBand();
  if (!band) return showToast("밴드를 선택해 주세요.", true);
  if (!window.confirm(`${band.name} 로고를 삭제할까요?`)) return;
  try {
    await call("updateBandLogo", { bandId: band.id, logoDataUrl: "" });
    applyBandLogoLocally(band.id, "");
    await loadBandDirectory();
    showToast(`${band.name} 로고를 삭제했습니다.`);
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}
async function handleBandDelete(event) {
  event.preventDefault();
  const band = selectedDeleteBand();
  if (!band) return showToast("삭제할 밴드를 선택해 주세요.", true);
  const message = `${band.name} 밴드를 삭제할까요?\n\n함께하는 밴드 목록에서 숨기고, 해당 밴드 관리자의 예약 권한을 비활성화합니다. 기존 예약 기록은 유지됩니다.`;
  if (!window.confirm(message)) return;
  try {
    await call("deleteBand", { bandId: band.id });
    state.pendingLogoDataUrl = null;
    elements.bandLogoFile.value = "";
    await loadBandDirectory();
    showToast(`${band.name} 밴드를 삭제했습니다.`);
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}
async function handleAnnouncement(event) {
  event.preventDefault();
  try {
    await addDoc(collection(db, "announcements"), {
      title: elements.announcementTitle.value.trim(),
      body: elements.announcementBody.value.trim(),
      active: true,
      authorUid: auth.currentUser.uid,
      publishedAt: serverTimestamp(),
    });
    elements.announcementForm.reset();
    showToast("공지를 게시했습니다.");
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}

async function handleSettings(event) {
  event.preventDefault();
  const openHour = Number(elements.openHour.value);
  const closeHour = Number(elements.closeHour.value);
  if (closeHour <= openHour) return showToast("마감 시간은 시작 시간보다 뒤여야 합니다.", true);
  try {
    const { setDoc } = await import("https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js");
    await setDoc(doc(db, "settings", "room"), { openHour, closeHour, slotMinutes: 60, updatedAt: serverTimestamp(), updatedBy: auth.currentUser.uid });
    showToast("운영 시간을 저장했습니다.");
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}


function bindEvents() {
  elements.openAuthButton.addEventListener("click", openAuth);
  elements.heroLoginButton.addEventListener("click", showReservationOverview);
  elements.closeAuthButton.addEventListener("click", () => elements.authDialog.close());
  elements.closeReservationButton.addEventListener("click", () => elements.reservationDialog.close());
  elements.showSignupButton.addEventListener("click", () => setDialogView("signupView"));
  elements.showLoginButton.addEventListener("click", () => setDialogView("authView"));
  elements.loginForm.addEventListener("submit", handleLogin);
  elements.signupForm.addEventListener("submit", handleSignup);
  elements.claimInviteForm.addEventListener("submit", handleClaimInvite);
  elements.bootstrapForm.addEventListener("submit", handleBootstrap);
  elements.reservationForm.addEventListener("submit", handleReservation);
  elements.bandForm.addEventListener("submit", handleBandCreate);
  elements.bandDeleteForm.addEventListener("submit", handleBandDelete);
  elements.bandLogoForm.addEventListener("submit", handleBandLogoSubmit);
  elements.bandLogoFile.addEventListener("change", handleBandLogoFile);
  elements.logoBand.addEventListener("change", () => {
    state.pendingLogoDataUrl = null;
    elements.bandLogoFile.value = "";
    renderBandLogoPreview();
  });
  elements.removeBandLogoButton.addEventListener("click", handleBandLogoRemove);
  elements.announcementForm.addEventListener("submit", handleAnnouncement);
  elements.settingsForm.addEventListener("submit", handleSettings);
  elements.signOutButton.addEventListener("click", async () => {
    forgetLoginId();
    await signOut(auth);
  });
  elements.weekStart.addEventListener("change", () => { if (state.profile) subscribeToAppData(); else loadPublicReservations(); renderCalendar(); });
  elements.startHour.addEventListener("change", () => {
    if (Number(elements.endHour.value) <= Number(elements.startHour.value)) elements.endHour.value = String(Number(elements.startHour.value) + 1);
  });
  elements.noticeList.addEventListener("click", async (event) => {
    const id = event.target.dataset.deleteNotice;
    if (!id || !window.confirm("이 공지를 삭제할까요?")) return;
    try { await deleteDoc(doc(db, "announcements", id)); showToast("공지를 삭제했습니다."); } catch (error) { showToast(errorMessage(error), true); }
  });
  elements.calendarWrap.addEventListener("click", (event) => {
    const id = event.target.closest("[data-reservation-id]")?.dataset.reservationId;
    if (id) showReservation(id);
  });
  elements.myReservationList.addEventListener("click", async (event) => {
    const id = event.target.dataset.cancelReservation;
    if (!id || !window.confirm("이 예약을 취소할까요?")) return;
    try { await call("cancelReservation", { reservationId: id }); showToast("예약을 취소했습니다."); } catch (error) { showToast(errorMessage(error), true); }
  });
}

function initialise() {
  const markupVersion = document.querySelector('meta[name="soundcheck-version"]')?.content;
  if (markupVersion !== APP_VERSION) {
    const url = new URL(window.location.href);
    if (url.searchParams.get("appVersion") !== APP_VERSION) {
      url.searchParams.set("appVersion", APP_VERSION);
      window.location.replace(url.toString());
      return;
    }
    showToast("화면 업데이트가 필요합니다. 브라우저를 완전히 닫고 다시 열어 주세요.", true);
    return;
  }
  const rememberedLoginId = localStorage.getItem(LOGIN_ID_STORAGE_KEY);
  if (rememberedLoginId && elements.activationLoginId) elements.activationLoginId.value = rememberedLoginId;
  const today = todayInSeoul();
  elements.weekStart.value = today;
  elements.reservationDate.value = today;
  elements.reservationDate.min = today;
  applyRoomToControls();
  bindEvents();
  setupAppInstall();
  registerServiceWorker();
  if (configMissing) {
    elements.noticeList.innerHTML = "<p class=\"empty-message\">Firebase 설정 후 공지사항과 시간표가 표시됩니다.</p>";
    elements.noticeCount.textContent = "설정 필요";
    elements.bandDirectory.innerHTML = "<p class=\"empty-message\">Firebase 설정 후 밴드 목록이 표시됩니다.</p>";
    elements.bandCount.textContent = "설정 필요";
    return;
  }
  subscribeToPublicData();
  onAuthStateChanged(auth, async (user) => {
    state.firebaseUser = user;
    await refreshProfile();
    renderProfile();
    if (state.profile) subscribeToAppData();
    else {
      clearAppSubscriptions();
      loadPublicReservations();
    }
  });
}

initialise();
