import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
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
const state = {
  firebaseUser: null,
  profile: null,
  bands: [],
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
    "auth/invalid-credential": "이메일 또는 비밀번호가 맞지 않습니다.",
    "auth/email-already-in-use": "이미 사용 중인 이메일입니다. 로그인해 주세요.",
    "auth/weak-password": "비밀번호는 8자 이상으로 설정해 주세요.",
    "auth/user-not-found": "등록된 계정을 찾지 못했습니다.",
    "auth/invalid-email": "이메일 주소를 확인해 주세요.",
  };
  return messages[error?.code] || error?.message || "처리 중 문제가 발생했습니다. 다시 시도해 주세요.";
}

function setDialogView(view) {
  ["authView", "signupView", "activationView"].forEach((id) => elements[id].classList.toggle("hidden", id !== view));
}

function openAuth() {
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
  if (state.profile?.role !== "main_admin") return;
  elements.reservationBand.innerHTML = state.bands.filter((band) => band.active).map((band) => `<option value="${band.id}">${escapeHtml(band.name)}</option>`).join("");
}

function renderProfile() {
  const profile = state.profile;
  const isActive = Boolean(profile);
  elements.profileChip.classList.toggle("hidden", !isActive);
  elements.signOutButton.classList.toggle("hidden", !state.firebaseUser);
  elements.openAuthButton.classList.toggle("hidden", Boolean(state.firebaseUser));
  elements.memberArea.classList.toggle("hidden", !isActive);
  elements.adminArea.classList.toggle("hidden", profile?.role !== "main_admin");
  elements.reservationBandField.classList.toggle("hidden", profile?.role !== "main_admin");
  if (!profile) {
    if (state.firebaseUser) elements.openAuthButton.classList.add("hidden");
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
  state.profile = snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
}

function subscribeToPublicData() {
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
    await signInWithEmailAndPassword(auth, elements.loginEmail.value.trim(), elements.loginPassword.value);
    elements.authDialog.close();
    showToast("로그인했습니다.");
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}

async function handleSignup(event) {
  event.preventDefault();
  try {
    const credential = await createUserWithEmailAndPassword(auth, elements.signupEmail.value.trim(), elements.signupPassword.value);
    await call("claimBandInvite", { displayName: elements.signupName.value.trim(), code: elements.signupInviteCode.value.trim() });
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
    await call("claimBandInvite", { displayName: elements.claimName.value.trim(), code: elements.claimInviteCode.value.trim() });
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
    await call("bootstrapMainAdmin", { displayName: elements.bootstrapName.value.trim(), code: elements.bootstrapCode.value });
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
    const result = await call("createBand", { name: elements.bandName.value.trim(), managerEmail: elements.managerEmail.value.trim() });
    const expires = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Seoul" }).format(new Date(result.data.expiresAt));
    elements.inviteResult.innerHTML = `<strong>${escapeHtml(result.data.code)}</strong><p><b>${escapeHtml(elements.bandName.value.trim())}</b> 관리자에게 이 코드를 전달하세요. ${expires}까지 한 번만 사용할 수 있습니다.</p>`;
    elements.inviteResult.classList.remove("hidden");
    elements.bandForm.reset();
    showToast("밴드를 추가하고 초대 코드를 만들었습니다.");
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
  elements.heroLoginButton.addEventListener("click", openAuth);
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
  elements.announcementForm.addEventListener("submit", handleAnnouncement);
  elements.settingsForm.addEventListener("submit", handleSettings);
  elements.signOutButton.addEventListener("click", () => signOut(auth));
  elements.weekStart.addEventListener("change", () => { if (state.profile) subscribeToAppData(); renderCalendar(); });
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
  elements.resetPasswordButton.addEventListener("click", async () => {
    const email = elements.loginEmail.value.trim();
    if (!email) return showToast("먼저 이메일을 입력해 주세요.", true);
    try { await sendPasswordResetEmail(auth, email); showToast("비밀번호 재설정 이메일을 보냈습니다."); } catch (error) { showToast(errorMessage(error), true); }
  });
}

function initialise() {
  const today = todayInSeoul();
  elements.weekStart.value = today;
  elements.reservationDate.value = today;
  elements.reservationDate.min = today;
  applyRoomToControls();
  bindEvents();
  if (configMissing) {
    elements.noticeList.innerHTML = "<p class=\"empty-message\">Firebase 설정 후 공지사항과 시간표가 표시됩니다.</p>";
    elements.noticeCount.textContent = "설정 필요";
    return;
  }
  subscribeToPublicData();
  onAuthStateChanged(auth, async (user) => {
    state.firebaseUser = user;
    await refreshProfile();
    renderProfile();
    if (state.profile) subscribeToAppData();
    else clearAppSubscriptions();
  });
}

initialise();
