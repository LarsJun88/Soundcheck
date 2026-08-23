const admin = require("firebase-admin");
const crypto = require("node:crypto");
const sharp = require("sharp");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");

admin.initializeApp();
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

setGlobalOptions({ region: "asia-northeast3", maxInstances: 10 });

const BOOTSTRAP_CODE = defineSecret("BOOTSTRAP_CODE");

const COLORS = ["#8B5CF6", "#0EA5E9", "#10B981", "#F97316", "#EC4899", "#EAB308"];
const DEFAULT_ROOM_SETTINGS = { openHour: 9, closeHour: 23, slotMinutes: 60 };
const LOGIN_ID_PATTERN = /^[가-힣a-z0-9_-]{2,12}$/i;
const INTERNAL_EMAIL_DOMAIN = "@id.soundcheck.local";
const MAX_LOGO_ORIGINAL_DATA_URL_LENGTH = 780000;
const MAX_LOGO_THUMBNAIL_DATA_URL_LENGTH = 90000;
const LOGO_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const PUSH_TOKEN_PATTERN = /^[A-Za-z0-9_:.-]{20,4096}$/;
const EQUIPMENT_PHOTO_DATA_URL_PATTERN = /^data:image\/(?:jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_EQUIPMENT_PHOTO_DATA_URL_LENGTH = 240000;
const MAX_RESERVATION_NOTE_LENGTH = 120;
const MAX_AVAILABILITY_POLL_TITLE_LENGTH = 50;
const MAX_AVAILABILITY_POLL_DATES = 31;
const EQUIPMENT_REPORT_STATUSES = new Set(["reported", "checking", "repairing", "resolved"]);
const INVALID_PUSH_TOKEN_CODES = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
]);
const PUSH_REMINDER_LEASE_MS = 10 * 60 * 1000;
const PUSH_REMINDER_DEFINITIONS = [
  { key: "day_before", field: "startAt", offsetMinutes: 24 * 60, title: "합주 예약 1일 전" },
  { key: "hour_before", field: "startAt", offsetMinutes: 60, title: "합주 예약 1시간 전" },
  { key: "end_soon", field: "endAt", offsetMinutes: 30, title: "합주 종료 30분 전" },
];
const TRASH_DAY_TITLES = [
  "일반·음식물쓰레기",
  "재활용품",
  "일반·음식물·불연성",
  "재활용품·기타",
  "일반·음식물쓰레기",
  "배출 안 함",
  "배출 안 함",
];

function badRequest(message) {
  throw new HttpsError("invalid-argument", message);
}

function requireAuth(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "로그인 후 이용할 수 있습니다.");
  }
  return request.auth;
}

async function getProfile(uid) {
  const snapshot = await db.collection("users").doc(uid).get();
  if (!snapshot.exists || !snapshot.data().active) {
    throw new HttpsError("permission-denied", "활성화된 관리자 계정이 아닙니다.");
  }
  return snapshot.data();
}

async function requireMainAdmin(request) {
  const auth = requireAuth(request);
  const profile = await getProfile(auth.uid);
  if (profile.role !== "main_admin") {
    throw new HttpsError("permission-denied", "메인 관리자만 수행할 수 있습니다.");
  }
  return { auth, profile };
}

function normaliseLoginId(value) {
  const loginId = String(value || "").trim().normalize("NFC").toLocaleLowerCase("ko-KR");
  if (!LOGIN_ID_PATTERN.test(loginId)) {
    badRequest("아이디는 한글·영문·숫자·밑줄·하이픈으로 2~12자까지 사용할 수 있습니다.");
  }
  return loginId;
}

function loginIdToAuthEmail(loginId) {
  return `id-${Buffer.from(loginId, "utf8").toString("base64url")}${INTERNAL_EMAIL_DOMAIN}`;
}

function requireVerifiedLoginId(request) {
  const loginId = normaliseLoginId(request.data?.loginId);
  const tokenEmail = String(request.auth?.token?.email || "").toLowerCase();
  if (tokenEmail !== loginIdToAuthEmail(loginId).toLowerCase()) {
    throw new HttpsError("permission-denied", "로그인 아이디를 확인할 수 없습니다.");
  }
  return loginId;
}
function dateInSeoul(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function parseReservationDate(date, hour) {
  const paddedHour = String(hour).padStart(2, "0");
  const value = new Date(`${date}T${paddedHour}:00:00+09:00`);
  if (Number.isNaN(value.getTime())) {
    badRequest("날짜 또는 시간을 확인해 주세요.");
  }
  return value;
}

function addDaysToDateText(dateText, amount) {
  const value = new Date(`${dateText}T12:00:00+09:00`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function validateMonthInput(value) {
  const month = String(value || "");
  if (!/^\d{4}-\d{2}$/.test(month)) badRequest("조회할 달을 확인해 주세요.");
  const [year, monthNumber] = month.split("-").map(Number);
  if (year < 2020 || year > 2100 || monthNumber < 1 || monthNumber > 12) badRequest("조회할 달을 확인해 주세요.");
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { month, from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}`, days: lastDay };
}

function slotId(date, hour) {
  return `${date}_${String(hour).padStart(2, "0")}`;
}

function validateReservationInput(data) {
  const date = String(data.date || "");
  const startHour = Number(data.startHour);
  const endHour = Number(data.endHour);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    badRequest("예약 날짜를 선택해 주세요.");
  }
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || startHour < 0 || endHour > 24 || endHour <= startHour) {
    badRequest("예약 시간은 한 시간 단위로 선택해 주세요.");
  }
  if (date < dateInSeoul()) {
    badRequest("지난 날짜에는 예약할 수 없습니다.");
  }
  return { date, startHour, endHour };
}

function validateReservationNote(value) {
  const note = String(value || "").trim();
  if (note.length > MAX_RESERVATION_NOTE_LENGTH) {
    badRequest(`예약 메모는 ${MAX_RESERVATION_NOTE_LENGTH}자까지 입력할 수 있습니다.`);
  }
  return note;
}

function dateDifferenceInDays(fromDate, toDate) {
  const from = new Date(`${fromDate}T12:00:00+09:00`).getTime();
  const to = new Date(`${toDate}T12:00:00+09:00`).getTime();
  return Math.round((to - from) / 86400000);
}

function validateAvailabilityDateRange(data) {
  const from = String(data?.from || "");
  const to = String(data?.to || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) {
    badRequest("조율할 날짜 범위를 확인해 주세요.");
  }
  if (from < dateInSeoul()) badRequest("오늘 이전 날짜로는 조율을 만들 수 없습니다.");
  const dayDifference = dateDifferenceInDays(from, to);
  if (dayDifference < 0 || dayDifference >= MAX_AVAILABILITY_POLL_DATES) {
    badRequest(`날짜 조율은 최대 ${MAX_AVAILABILITY_POLL_DATES}일까지 만들 수 있습니다.`);
  }
  return Array.from({ length: dayDifference + 1 }, (_, index) => addDaysToDateText(from, index));
}

async function confirmedReservationDates(from, to) {
  if (!from || !to || to < from) return new Set();
  const snapshot = await db.collection("reservations")
    .where("status", "==", "confirmed")
    .where("date", ">=", from)
    .where("date", "<=", to)
    .orderBy("date")
    .orderBy("startHour")
    .get();
  return new Set(snapshot.docs.map((item) => String(item.data().date || "")).filter(Boolean));
}

function validateReservationRangeInput(data) {
  const from = String(data.from || dateInSeoul());
  const to = String(data.to || from);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) {
    badRequest("예약 조회 날짜를 확인해 주세요.");
  }
  const fromDate = new Date(`${from}T00:00:00+09:00`);
  const toDate = new Date(`${to}T00:00:00+09:00`);
  if ((toDate.getTime() - fromDate.getTime()) / 86400000 > 31) {
    badRequest("예약 조회는 한 번에 31일까지만 가능합니다.");
  }
  return { from, to };
}

function displayTime(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function pushTokenId(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function trashTitleForDate(dateText) {
  const weekday = new Date(`${dateText}T12:00:00+09:00`).getUTCDay();
  return TRASH_DAY_TITLES[weekday] || "쓰레기 배출 안내";
}

function reservationDateLabel(dateText) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date(`${dateText}T12:00:00+09:00`));
}

async function activePushTokenDocsForBand(bandId) {
  if (!bandId) return [];
  const snapshot = await db.collection("pushTokens").where("bandId", "==", bandId).get();
  return snapshot.docs.filter((item) => item.data().enabled !== false && PUSH_TOKEN_PATTERN.test(String(item.data().token || "")));
}

async function sendPushToBand(bandId, payload) {
  const tokenDocs = await activePushTokenDocsForBand(bandId);
  if (!tokenDocs.length) return { attempted: 0, delivered: 0 };

  let delivered = 0;
  const staleRefs = [];
  for (let offset = 0; offset < tokenDocs.length; offset += 500) {
    const chunk = tokenDocs.slice(offset, offset + 500);
    const response = await admin.messaging().sendEachForMulticast({
      tokens: chunk.map((item) => item.data().token),
      data: {
        title: String(payload.title || "Soundcheck"),
        body: String(payload.body || "합주실 예약을 확인해 주세요."),
        url: String(payload.url || "./#schedule"),
        kind: String(payload.kind || "reservation"),
        reservationId: String(payload.reservationId || ""),
      },
      webpush: { headers: { Urgency: payload.urgent ? "high" : "normal" } },
    });
    delivered += response.successCount;
    response.responses.forEach((result, index) => {
      if (!result.success && INVALID_PUSH_TOKEN_CODES.has(result.error?.code)) staleRefs.push(chunk[index].ref);
    });
  }
  await Promise.allSettled(staleRefs.map((reference) => reference.delete()));
  return { attempted: tokenDocs.length, delivered };
}

function reminderPayload(reservation, definition) {
  const dateAndTime = `${reservationDateLabel(reservation.date)} ${displayTime(reservation.startHour)}–${displayTime(reservation.endHour)}`;
  if (definition.key === "end_soon") {
    return {
      title: `${definition.title} · ${trashTitleForDate(reservation.date)}`,
      body: `${reservation.bandName} 합주가 곧 끝납니다. 장비 정리와 오늘의 쓰레기 배출 품목을 확인해 주세요.`,
      kind: definition.key,
      reservationId: reservation.id,
      url: "./#trashSchedule",
      urgent: true,
    };
  }
  return {
    title: definition.title,
    body: `${reservation.bandName} · ${dateAndTime}`,
    kind: definition.key,
    reservationId: reservation.id,
    url: "./#schedule",
    urgent: definition.key === "hour_before",
  };
}

async function claimPushReminder(reservationId, reminderKey) {
  const reference = db.collection("pushReminderDeliveries").doc(`${reservationId}_${reminderKey}`);
  const now = Timestamp.now();
  const claimed = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const data = snapshot.exists ? snapshot.data() : null;
    const claimTime = data?.claimedAt?.toMillis?.() || 0;
    if (data?.sentAt || (claimTime && now.toMillis() - claimTime < PUSH_REMINDER_LEASE_MS)) return false;
    transaction.set(reference, { reservationId, reminderKey, status: "processing", claimedAt: now }, { merge: true });
    return true;
  });
  return { claimed, reference };
}

async function dueReservations(definition, now = new Date()) {
  const targetTime = now.getTime() + (definition.offsetMinutes * 60000);
  const windowStart = Timestamp.fromMillis(targetTime - (5 * 60000));
  const windowEnd = Timestamp.fromMillis(targetTime + (5 * 60000));
  const snapshot = await db.collection("reservations")
    .where(definition.field, ">=", windowStart)
    .where(definition.field, "<", windowEnd)
    .get();
  return snapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .filter((reservation) => reservation.status === "confirmed");
}

async function createServerLogoThumbnail(logoDataUrl) {
  const match = LOGO_DATA_URL_PATTERN.exec(logoDataUrl);
  if (!match) throw new Error("Unsupported legacy logo format");
  const base64 = logoDataUrl.slice(logoDataUrl.indexOf(",") + 1);
  const source = Buffer.from(base64, "base64");
  const thumbnail = await sharp(source)
    .rotate()
    .resize({ width: 240, height: 240, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 68, effort: 4 })
    .toBuffer();
  const result = `data:image/webp;base64,${thumbnail.toString("base64")}`;
  if (result.length > MAX_LOGO_THUMBNAIL_DATA_URL_LENGTH) {
    throw new Error("Generated logo thumbnail is too large");
  }
  return result;
}

exports.bootstrapMainAdmin = onCall(
  { secrets: [BOOTSTRAP_CODE] },
  async (request) => {
    const auth = requireAuth(request);
    const loginId = requireVerifiedLoginId(request);
    if (String(request.data?.code || "") !== BOOTSTRAP_CODE.value()) {
      throw new HttpsError("permission-denied", "초기 메인 관리자 코드가 일치하지 않습니다.");
    }

    const displayName = String(request.data?.displayName || "").trim().slice(0, 40);
    if (!displayName) badRequest("표시할 이름을 입력해 주세요.");

    const systemRef = db.collection("system").doc("setup");
    const userRef = db.collection("users").doc(auth.uid);
    await db.runTransaction(async (transaction) => {
      const setup = await transaction.get(systemRef);
      if (setup.exists && setup.data().mainAdminUid) {
        throw new HttpsError("already-exists", "메인 관리자는 이미 등록되어 있습니다.");
      }
      transaction.set(systemRef, { mainAdminUid: auth.uid, initializedAt: FieldValue.serverTimestamp() });
      transaction.set(userRef, {
        displayName,
        loginId,
        role: "main_admin",
        bandId: null,
        active: true,
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    return { role: "main_admin" };
  },
);

exports.createBand = onCall(async (request) => {
  const { auth } = await requireMainAdmin(request);
  const name = String(request.data?.name || "").trim().slice(0, 40);
  if (name.length < 2) badRequest("밴드 이름은 두 글자 이상 입력해 주세요.");

  const bandRef = db.collection("bands").doc();
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];

  await bandRef.set({
    name,
    memberUids: [],
    memberCount: 0,
    color,
    active: true,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: auth.uid,
  });

  return { bandId: bandRef.id, name };
});

exports.listMemberRoster = onCall(async (request) => {
  await requireMainAdmin(request);
  const [usersSnapshot, bandsSnapshot] = await Promise.all([
    db.collection("users").get(),
    db.collection("bands").get(),
  ]);
  const bandNames = new Map(bandsSnapshot.docs.map((item) => [item.id, String(item.data().name || "")]));
  const members = usersSnapshot.docs.map((item) => {
    const profile = item.data();
    const createdAtValue = profile.joinedAt || profile.createdAt;
    return {
      displayName: String(profile.displayName || "이름 없음").slice(0, 40),
      loginId: String(profile.loginId || "").slice(0, 40),
      role: profile.role === "main_admin" ? "main_admin" : "band_admin",
      bandName: profile.bandId ? String(bandNames.get(profile.bandId) || "삭제된 밴드") : "",
      active: profile.active === true,
      createdAt: createdAtValue?.toDate ? createdAtValue.toDate().toISOString() : "",
    };
  }).sort((a, b) => Number(b.active) - Number(a.active)
    || a.bandName.localeCompare(b.bandName, "ko")
    || a.displayName.localeCompare(b.displayName, "ko"));
  return {
    members,
    summary: {
      total: members.length,
      active: members.filter((member) => member.active).length,
      inactive: members.filter((member) => !member.active).length,
    },
  };
});

exports.createAvailabilityPoll = onCall(async (request) => {
  const auth = requireAuth(request);
  const profile = await getProfile(auth.uid);
  if (profile.role !== "band_admin" || !profile.bandId) {
    throw new HttpsError("permission-denied", "밴드 멤버만 날짜 조율을 만들 수 있습니다.");
  }
  const title = String(request.data?.title || "").trim();
  if (title.length < 2 || title.length > MAX_AVAILABILITY_POLL_TITLE_LENGTH) {
    badRequest(`조율 제목은 2~${MAX_AVAILABILITY_POLL_TITLE_LENGTH}자로 입력해 주세요.`);
  }
  const requestedDates = validateAvailabilityDateRange(request.data || {});
  const reservedDates = await confirmedReservationDates(requestedDates[0], requestedDates[requestedDates.length - 1]);
  const dates = requestedDates.filter((date) => !reservedDates.has(date));
  if (!dates.length) badRequest("선택한 기간은 모든 날짜에 이미 예약이 있습니다. 다른 기간을 선택해 주세요.");
  const bandId = String(profile.bandId);

  const bandSnapshot = await db.collection("bands").doc(bandId).get();
  if (!bandSnapshot.exists || bandSnapshot.data().active === false) {
    throw new HttpsError("not-found", "조율을 만들 밴드를 찾을 수 없습니다.");
  }
  const pollRef = db.collection("availabilityPolls").doc();
  await pollRef.set({
    bandId,
    bandName: String(bandSnapshot.data().name || "등록 밴드").slice(0, 40),
    title,
    dates,
    status: "open",
    createdBy: auth.uid,
    createdByName: String(profile.displayName || "밴드원").slice(0, 40),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { pollId: pollRef.id };
});

exports.listAvailabilityPolls = onCall(async (request) => {
  const auth = requireAuth(request);
  const profile = await getProfile(auth.uid);
  if (profile.role !== "band_admin" || !profile.bandId) {
    throw new HttpsError("permission-denied", "해당 밴드 멤버만 날짜 조율을 볼 수 있습니다.");
  }
  const pollsSnapshot = await db.collection("availabilityPolls")
    .where("bandId", "==", String(profile.bandId))
    .get();
  const pollDocs = pollsSnapshot.docs
    .filter((snapshot) => snapshot.data().status === "open")
    .sort((a, b) => (b.data().createdAt?.toMillis?.() || 0) - (a.data().createdAt?.toMillis?.() || 0))
    .slice(0, 60);
  const allPollDates = pollDocs.flatMap((snapshot) => (
    Array.isArray(snapshot.data().dates) ? snapshot.data().dates.map(String) : []
  )).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
  const reservedDates = allPollDates.length
    ? await confirmedReservationDates(allPollDates[0], allPollDates[allPollDates.length - 1])
    : new Set();
  const bandIds = [...new Set(pollDocs.map((snapshot) => String(snapshot.data().bandId || "")).filter(Boolean))];
  const memberSnapshots = await Promise.all(bandIds.map((bandId) => (
    db.collection("users").where("bandId", "==", bandId).get()
  )));
  const membersByBand = new Map(memberSnapshots.map((snapshot, index) => [bandIds[index], snapshot.docs
    .filter((member) => member.data().active === true && member.data().role === "band_admin")
    .map((member) => ({ id: member.id, displayName: String(member.data().displayName || "이름 없음").slice(0, 40) }))]));

  const polls = await Promise.all(pollDocs.map(async (snapshot) => {
    const poll = snapshot.data();
    const dates = Array.isArray(poll.dates)
      ? poll.dates.map(String).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && !reservedDates.has(date))
      : [];
    const members = membersByBand.get(String(poll.bandId || "")) || [];
    const memberIds = new Set(members.map((member) => member.id));
    const responsesSnapshot = await snapshot.ref.collection("responses").get();
    const activeResponses = responsesSnapshot.docs.filter((response) => memberIds.has(response.id));
    const responseById = new Map(activeResponses.map((response) => [response.id, response.data()]));
    const dateResults = dates.map((date) => ({
      date,
      count: activeResponses.filter((response) => {
        const availableDates = Array.isArray(response.data().availableDates) ? response.data().availableDates : [];
        return availableDates.includes(date);
      }).length,
    }));
    const maximumCount = dateResults.reduce((maximum, result) => Math.max(maximum, result.count), 0);
    const selfResponse = responseById.get(auth.uid);
    return {
      id: snapshot.id,
      bandId: String(poll.bandId || ""),
      bandName: String(poll.bandName || "등록 밴드").slice(0, 40),
      title: String(poll.title || "날짜 조율").slice(0, MAX_AVAILABILITY_POLL_TITLE_LENGTH),
      dates,
      createdByName: String(poll.createdByName || "밴드원").slice(0, 40),
      createdAt: poll.createdAt?.toDate ? poll.createdAt.toDate().toISOString() : "",
      totalMembers: members.length,
      respondedCount: activeResponses.length,
      missingMembers: members.filter((member) => !responseById.has(member.id)).map((member) => member.displayName),
      dateResults: dateResults.map((result) => ({
        ...result,
        allAvailable: members.length > 0 && result.count === members.length,
        maximum: maximumCount > 0 && result.count === maximumCount,
      })),
      maximumCount,
      canRespond: profile.role === "band_admin" && String(profile.bandId || "") === String(poll.bandId || ""),
      hasResponded: Boolean(selfResponse),
      selfAvailableDates: Array.isArray(selfResponse?.availableDates)
        ? selfResponse.availableDates.filter((date) => dates.includes(date))
        : [],
    };
  }));
  return { polls };
});

exports.submitAvailabilityResponse = onCall(async (request) => {
  const auth = requireAuth(request);
  const profile = await getProfile(auth.uid);
  if (profile.role !== "band_admin" || !profile.bandId) {
    throw new HttpsError("permission-denied", "밴드원만 날짜 가능 여부를 입력할 수 있습니다.");
  }
  const pollId = String(request.data?.pollId || "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(pollId)) badRequest("날짜 조율 정보를 확인해 주세요.");
  const pollRef = db.collection("availabilityPolls").doc(pollId);
  const pollSnapshot = await pollRef.get();
  if (!pollSnapshot.exists || pollSnapshot.data().status !== "open") {
    throw new HttpsError("not-found", "진행 중인 날짜 조율을 찾을 수 없습니다.");
  }
  const poll = pollSnapshot.data();
  if (String(poll.bandId || "") !== String(profile.bandId || "")) {
    throw new HttpsError("permission-denied", "자신의 밴드 날짜 조율에만 응답할 수 있습니다.");
  }
  const storedPollDates = Array.isArray(poll.dates) ? poll.dates.map(String) : [];
  const reservedDates = storedPollDates.length
    ? await confirmedReservationDates(storedPollDates[0], storedPollDates[storedPollDates.length - 1])
    : new Set();
  const pollDates = storedPollDates.filter((date) => !reservedDates.has(date));
  const requestedDates = Array.isArray(request.data?.availableDates) ? request.data.availableDates.map(String) : [];
  const availableDates = [...new Set(requestedDates)];
  if (availableDates.some((date) => !pollDates.includes(date))) {
    badRequest("선택한 날짜에 이미 예약이 있습니다. 조율 화면을 새로고침해 주세요.");
  }
  await pollRef.collection("responses").doc(auth.uid).set({
    availableDates,
    displayName: String(profile.displayName || "밴드원").slice(0, 40),
    respondedAt: FieldValue.serverTimestamp(),
  });
  await pollRef.set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { saved: true, availableCount: availableDates.length };
});

exports.deleteBand = onCall(async (request) => {
  const { auth } = await requireMainAdmin(request);
  const bandId = String(request.data?.bandId || "").trim();
  if (!bandId) badRequest("삭제할 밴드를 선택해 주세요.");

  const bandRef = db.collection("bands").doc(bandId);
  const logoOriginalRef = db.collection("bandLogoOriginals").doc(bandId);
  const inviteQuery = db.collection("bandInvites").where("bandId", "==", bandId).where("status", "==", "pending");
  const memberQuery = db.collection("users").where("bandId", "==", bandId);
  let bandName = "";

  await db.runTransaction(async (transaction) => {
    const bandSnapshot = await transaction.get(bandRef);
    if (!bandSnapshot.exists || !bandSnapshot.data().active) {
      throw new HttpsError("not-found", "삭제할 밴드를 찾을 수 없습니다.");
    }
    const band = bandSnapshot.data();
    bandName = String(band.name || "");
    const pendingInvites = await transaction.get(inviteQuery);
    const members = await transaction.get(memberQuery);

    transaction.update(bandRef, {
      active: false,
      deletedAt: FieldValue.serverTimestamp(),
      deletedBy: auth.uid,
    });
    transaction.delete(logoOriginalRef);
    pendingInvites.docs.forEach((invite) => {
      transaction.update(invite.ref, {
        status: "cancelled",
        cancelledAt: FieldValue.serverTimestamp(),
        cancelledBy: auth.uid,
      });
    });
    members.docs.forEach((member) => {
      const memberData = member.data();
      if (memberData.role !== "band_admin" || memberData.active === false) return;
      transaction.update(member.ref, {
        active: false,
        deactivatedAt: FieldValue.serverTimestamp(),
        deactivatedBy: auth.uid,
      });
    });
  });

  return { bandId, bandName };
});

exports.listBandDirectory = onCall(async () => {
  const snapshot = await db.collection("bands").where("active", "==", true).get();
  const migrations = [];
  const bands = await Promise.all(snapshot.docs.map(async (item) => {
    const band = item.data();
    const legacyLogoDataUrl = typeof band.logoDataUrl === "string" ? band.logoDataUrl : "";
    let logoThumbnailDataUrl = typeof band.logoThumbnailDataUrl === "string" ? band.logoThumbnailDataUrl : "";
    if (!logoThumbnailDataUrl && legacyLogoDataUrl) {
      try {
        logoThumbnailDataUrl = await createServerLogoThumbnail(legacyLogoDataUrl);
        migrations.push({ ref: item.ref, bandId: item.id, legacyLogoDataUrl, logoThumbnailDataUrl, updatedBy: band.logoUpdatedBy || "legacy-migration" });
      } catch (error) {
        console.error(`Could not create a thumbnail for band ${item.id}`, error);
        logoThumbnailDataUrl = legacyLogoDataUrl;
      }
    }
    return {
      id: item.id,
      name: String(band.name || "").slice(0, 40),
      color: String(band.color || "#8B5CF6"),
      logoThumbnailDataUrl,
      hasLogo: Boolean(logoThumbnailDataUrl || legacyLogoDataUrl),
    };
  }));

  await Promise.allSettled(migrations.map((migration) => db.runTransaction(async (transaction) => {
    const freshSnapshot = await transaction.get(migration.ref);
    if (!freshSnapshot.exists || freshSnapshot.data().logoDataUrl !== migration.legacyLogoDataUrl) return;
    transaction.set(db.collection("bandLogoOriginals").doc(migration.bandId), {
      bandId: migration.bandId,
      logoDataUrl: migration.legacyLogoDataUrl,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: migration.updatedBy,
    }, { merge: true });
    transaction.update(migration.ref, {
      logoDataUrl: FieldValue.delete(),
      logoThumbnailDataUrl: migration.logoThumbnailDataUrl,
      logoMigratedAt: FieldValue.serverTimestamp(),
    });
  })));

  bands.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return { bands };
});
exports.listPublicReservations = onCall(async (request) => {
  const { from, to } = validateReservationRangeInput(request.data || {});
  const snapshot = await db.collection("reservations")
    .where("status", "==", "confirmed")
    .where("date", ">=", from)
    .where("date", "<=", to)
    .orderBy("date")
    .orderBy("startHour")
    .get();
  const reservations = snapshot.docs.map((item) => {
    const reservation = item.data();
    return {
      id: item.id,
      bandId: String(reservation.bandId || ""),
      bandName: String(reservation.bandName || "").slice(0, 40),
      bandColor: String(reservation.bandColor || "#8B5CF6"),
      date: String(reservation.date || ""),
      startHour: Number(reservation.startHour),
      endHour: Number(reservation.endHour),
      status: "confirmed",
      repeatGroupId: String(reservation.repeatGroupId || ""),
      repeatIndex: Number(reservation.repeatIndex || 0),
      repeatCount: Number(reservation.repeatCount || 1),
      note: String(reservation.note || "").slice(0, MAX_RESERVATION_NOTE_LENGTH),
    };
  });
  return { reservations };
});

exports.getBandLogo = onCall(async (request) => {
  const bandId = String(request.data?.bandId || "").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(bandId)) badRequest("밴드 로고 정보가 올바르지 않습니다.");

  const [bandSnapshot, originalSnapshot] = await Promise.all([
    db.collection("bands").doc(bandId).get(),
    db.collection("bandLogoOriginals").doc(bandId).get(),
  ]);
  if (!bandSnapshot.exists || bandSnapshot.data().active === false) {
    throw new HttpsError("not-found", "밴드 로고를 찾을 수 없습니다.");
  }
  const band = bandSnapshot.data();
  const original = originalSnapshot.exists ? originalSnapshot.data() : {};
  const logoDataUrl = String(original.logoDataUrl || band.logoDataUrl || band.logoThumbnailDataUrl || "");
  if (!logoDataUrl) throw new HttpsError("not-found", "등록된 밴드 로고가 없습니다.");

  return {
    bandId,
    bandName: String(band.name || "").slice(0, 40),
    logoDataUrl,
  };
});

exports.updateBandLogo = onCall(async (request) => {
  const { auth } = await requireMainAdmin(request);
  const bandId = String(request.data?.bandId || "").trim();
  const logoDataUrl = String(request.data?.logoDataUrl || "");
  const logoThumbnailDataUrl = String(request.data?.logoThumbnailDataUrl || "");
  if (!bandId) badRequest("로고를 변경할 밴드를 선택해 주세요.");
  const hasOriginal = Boolean(logoDataUrl);
  const hasThumbnail = Boolean(logoThumbnailDataUrl);
  if (hasOriginal !== hasThumbnail) badRequest("로고 원본과 썸네일을 함께 등록해 주세요.");
  if (hasOriginal && (
    logoDataUrl.length > MAX_LOGO_ORIGINAL_DATA_URL_LENGTH
    || logoThumbnailDataUrl.length > MAX_LOGO_THUMBNAIL_DATA_URL_LENGTH
    || !LOGO_DATA_URL_PATTERN.test(logoDataUrl)
    || !LOGO_DATA_URL_PATTERN.test(logoThumbnailDataUrl)
  )) {
    badRequest("로고는 PNG·JPG·WebP 형식의 작은 이미지로 등록해 주세요.");
  }

  const bandRef = db.collection("bands").doc(bandId);
  const originalRef = db.collection("bandLogoOriginals").doc(bandId);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(bandRef);
    if (!snapshot.exists || !snapshot.data().active) {
      throw new HttpsError("not-found", "로고를 변경할 밴드를 찾을 수 없습니다.");
    }
    transaction.update(bandRef, {
      logoDataUrl: FieldValue.delete(),
      logoThumbnailDataUrl,
      logoUpdatedAt: FieldValue.serverTimestamp(),
      logoUpdatedBy: auth.uid,
    });
    if (hasOriginal) {
      transaction.set(originalRef, {
        bandId,
        logoDataUrl,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: auth.uid,
      });
    } else {
      transaction.delete(originalRef);
    }
  });

  return { bandId, hasLogo: hasOriginal };
});
exports.joinBand = onCall(async (request) => {
  const auth = requireAuth(request);
  const loginId = requireVerifiedLoginId(request);
  const bandId = String(request.data?.bandId || "").trim();
  const displayName = String(request.data?.displayName || "").trim().slice(0, 40);
  if (!bandId || !displayName) {
    badRequest("밴드와 표시할 이름을 확인해 주세요.");
  }

  const userRef = db.collection("users").doc(auth.uid);
  const bandRef = db.collection("bands").doc(bandId);
  let bandName = "";

  await db.runTransaction(async (transaction) => {
    const [existingProfile, bandSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(bandRef),
    ]);
    if (existingProfile.exists && existingProfile.data().active !== false) {
      throw new HttpsError("already-exists", "이미 활성화된 계정입니다.");
    }
    if (!bandSnapshot.exists || !bandSnapshot.data().active) {
      throw new HttpsError("not-found", "선택한 밴드를 찾을 수 없습니다.");
    }

    bandName = String(bandSnapshot.data().name || "");
    transaction.set(userRef, {
      displayName,
      loginId,
      role: "band_admin",
      bandId,
      active: true,
      createdAt: FieldValue.serverTimestamp(),
      joinedAt: FieldValue.serverTimestamp(),
    });
    transaction.update(bandRef, {
      memberUids: FieldValue.arrayUnion(auth.uid),
      memberCount: FieldValue.increment(1),
      lastJoinedAt: FieldValue.serverTimestamp(),
    });
  });

  return { role: "band_admin", bandName };
});

exports.claimBandInvite = onCall(async (request) => {
  const auth = requireAuth(request);
  const code = String(request.data?.code || "").trim().toUpperCase();
  const displayName = String(request.data?.displayName || "").trim().slice(0, 40);
  if (!/^[A-Z0-9]{10}$/.test(code) || !displayName) {
    badRequest("초대 코드와 표시할 이름을 확인해 주세요.");
  }
  const loginId = requireVerifiedLoginId(request);
  const userRef = db.collection("users").doc(auth.uid);
  const inviteQuery = db.collection("bandInvites").where("code", "==", code).limit(1);

  let bandName = "";
  await db.runTransaction(async (transaction) => {
    const [existingProfile, inviteSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(inviteQuery),
    ]);
    if (existingProfile.exists) {
      throw new HttpsError("already-exists", "이미 활성화된 관리자 계정입니다.");
    }
    if (inviteSnapshot.empty) {
      throw new HttpsError("not-found", "유효한 밴드 초대 코드를 찾지 못했습니다.");
    }
    const inviteDoc = inviteSnapshot.docs[0];
    const invite = inviteDoc.data();
    if (invite.status !== "pending" || invite.expiresAt.toDate() < new Date()) {
      throw new HttpsError("failed-precondition", "만료되었거나 이미 사용된 초대 코드입니다.");
    }
    if (invite.managerLoginId !== loginId) {
      throw new HttpsError("permission-denied", "초대받은 아이디로 로그인해 주세요.");
    }

    const bandRef = db.collection("bands").doc(invite.bandId);
    const bandSnapshot = await transaction.get(bandRef);
    if (!bandSnapshot.exists || !bandSnapshot.data().active) {
      throw new HttpsError("failed-precondition", "현재 사용할 수 없는 밴드입니다.");
    }
    bandName = bandSnapshot.data().name;
    transaction.set(userRef, {
      displayName,
      loginId,
      role: "band_admin",
      bandId: invite.bandId,
      active: true,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.update(bandRef, { managerUid: auth.uid, managerLoginId: loginId, activatedAt: FieldValue.serverTimestamp() });
    transaction.update(inviteDoc.ref, { status: "claimed", claimedBy: auth.uid, claimedAt: FieldValue.serverTimestamp() });
  });

  return { role: "band_admin", bandName };
});

exports.registerPushToken = onCall(async (request) => {
  const auth = requireAuth(request);
  const profile = await getProfile(auth.uid);
  const token = String(request.data?.token || "").trim();
  if (!PUSH_TOKEN_PATTERN.test(token)) badRequest("알림 기기 정보가 올바르지 않습니다.");

  const reference = db.collection("pushTokens").doc(pushTokenId(token));
  await reference.set({
    token,
    uid: auth.uid,
    bandId: profile.bandId || null,
    role: profile.role,
    enabled: true,
    userAgent: String(request.data?.userAgent || "").slice(0, 300),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { enabled: true };
});

exports.unregisterPushToken = onCall(async (request) => {
  const auth = requireAuth(request);
  const token = String(request.data?.token || "").trim();
  if (!PUSH_TOKEN_PATTERN.test(token)) return { removed: false };
  const reference = db.collection("pushTokens").doc(pushTokenId(token));
  const snapshot = await reference.get();
  if (snapshot.exists && snapshot.data().uid === auth.uid) await reference.delete();
  return { removed: true };
});

exports.listEquipmentReports = onCall(async (request) => {
  const auth = requireAuth(request);
  await getProfile(auth.uid);
  const snapshot = await db.collection("equipmentReports")
    .orderBy("createdAt", "desc")
    .limit(30)
    .get();
  return {
    reports: snapshot.docs.map((item) => {
      const report = item.data();
      return {
        id: item.id,
        equipmentName: String(report.equipmentName || "").slice(0, 60),
        description: String(report.description || "").slice(0, 600),
        photoDataUrl: String(report.photoDataUrl || ""),
        status: EQUIPMENT_REPORT_STATUSES.has(report.status) ? report.status : "reported",
        reporterName: String(report.reporterName || "").slice(0, 40),
        bandName: String(report.bandName || "").slice(0, 40),
        createdAtMillis: report.createdAt?.toMillis?.() || 0,
        updatedAtMillis: report.updatedAt?.toMillis?.() || 0,
      };
    }),
  };
});

exports.createEquipmentReport = onCall(async (request) => {
  const auth = requireAuth(request);
  const profile = await getProfile(auth.uid);
  const equipmentName = String(request.data?.equipmentName || "").trim();
  const description = String(request.data?.description || "").trim();
  const photoDataUrl = String(request.data?.photoDataUrl || "").trim();
  if (equipmentName.length < 2 || equipmentName.length > 60) badRequest("장비 이름을 2~60자로 입력해 주세요.");
  if (description.length < 2 || description.length > 600) badRequest("이상 내용을 2~600자로 입력해 주세요.");
  if (photoDataUrl && (!EQUIPMENT_PHOTO_DATA_URL_PATTERN.test(photoDataUrl) || photoDataUrl.length > MAX_EQUIPMENT_PHOTO_DATA_URL_LENGTH)) {
    badRequest("장비 사진을 다시 선택해 주세요.");
  }
  let bandName = "메인 관리자";
  if (profile.bandId) {
    const bandSnapshot = await db.collection("bands").doc(profile.bandId).get();
    bandName = String(bandSnapshot.data()?.name || "등록 밴드");
  }
  const reference = db.collection("equipmentReports").doc();
  await reference.set({
    equipmentName,
    description,
    photoDataUrl,
    status: "reported",
    reporterUid: auth.uid,
    reporterName: String(profile.displayName || "사용자").slice(0, 40),
    bandId: String(profile.bandId || ""),
    bandName: bandName.slice(0, 40),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { reportId: reference.id };
});

exports.updateEquipmentReportStatus = onCall(async (request) => {
  const { auth } = await requireMainAdmin(request);
  const reportId = String(request.data?.reportId || "").trim();
  const status = String(request.data?.status || "").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(reportId) || !EQUIPMENT_REPORT_STATUSES.has(status)) {
    badRequest("장비 신고 상태를 확인해 주세요.");
  }
  const reference = db.collection("equipmentReports").doc(reportId);
  const snapshot = await reference.get();
  if (!snapshot.exists) throw new HttpsError("not-found", "장비 신고를 찾을 수 없습니다.");
  await reference.update({
    status,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: auth.uid,
    ...(status === "resolved" ? { resolvedAt: FieldValue.serverTimestamp() } : { resolvedAt: FieldValue.delete() }),
  });
  return { updated: true };
});

exports.getMonthlyUsageStats = onCall(async (request) => {
  await requireMainAdmin(request);
  const range = validateMonthInput(request.data?.month);
  const [reservationSnapshot, bandSnapshot, roomSnapshot] = await Promise.all([
    db.collection("reservations").where("date", ">=", range.from).where("date", "<=", range.to).orderBy("date").get(),
    db.collection("bands").get(),
    db.collection("settings").doc("room").get(),
  ]);
  const room = roomSnapshot.exists ? { ...DEFAULT_ROOM_SETTINGS, ...roomSnapshot.data() } : DEFAULT_ROOM_SETTINGS;
  const byBand = new Map();
  bandSnapshot.docs.forEach((item) => {
    const band = item.data();
    byBand.set(item.id, { bandId: item.id, bandName: String(band.name || "등록 밴드"), color: String(band.color || "#8B5CF6"), hours: 0, reservations: 0, cancellations: 0 });
  });
  const hours = new Map();
  let totalHours = 0;
  let totalReservations = 0;
  let cancellations = 0;
  const usedDates = new Set();
  reservationSnapshot.docs.forEach((item) => {
    const reservation = item.data();
    const bandId = String(reservation.bandId || "unknown");
    if (!byBand.has(bandId)) byBand.set(bandId, { bandId, bandName: String(reservation.bandName || "이전 밴드"), color: String(reservation.bandColor || "#8B5CF6"), hours: 0, reservations: 0, cancellations: 0 });
    const band = byBand.get(bandId);
    if (reservation.status === "cancelled") {
      cancellations += 1;
      band.cancellations += 1;
      return;
    }
    if (reservation.status !== "confirmed") return;
    const duration = Math.max(0, Number(reservation.endHour) - Number(reservation.startHour));
    totalHours += duration;
    totalReservations += 1;
    usedDates.add(String(reservation.date || ""));
    band.hours += duration;
    band.reservations += 1;
    for (let hour = Number(reservation.startHour); hour < Number(reservation.endHour); hour += 1) hours.set(hour, (hours.get(hour) || 0) + 1);
  });
  const availableHours = range.days * Math.max(0, Number(room.closeHour) - Number(room.openHour));
  const popularHours = [...hours.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 3)
    .map(([hour, count]) => ({ hour, count }));
  return {
    month: range.month,
    summary: {
      totalHours,
      totalReservations,
      cancellations,
      usedDays: usedDates.size,
      utilizationRate: availableHours ? Math.round((totalHours / availableHours) * 1000) / 10 : 0,
    },
    bands: [...byBand.values()].filter((band) => band.hours || band.reservations || band.cancellations).sort((a, b) => b.hours - a.hours || a.bandName.localeCompare(b.bandName, "ko")),
    popularHours,
  };
});
exports.createReservation = onCall(async (request) => {
  const auth = requireAuth(request);
  const profile = await getProfile(auth.uid);
  const { date, startHour, endHour } = validateReservationInput(request.data || {});
  let bandId = String(request.data?.bandId || "");

  if (profile.role === "band_admin") {
    bandId = profile.bandId;
  } else if (profile.role !== "main_admin" || !bandId) {
    throw new HttpsError("permission-denied", "예약 권한이 없습니다.");
  }

  const repeatWeeks = Number(request.data?.repeatWeeks || 1);
  const note = validateReservationNote(request.data?.note);
  if (!Number.isInteger(repeatWeeks) || ![1, 4].includes(repeatWeeks)) badRequest("반복 예약은 한 달(4주) 단위로만 가능합니다.");
  const dates = Array.from({ length: repeatWeeks }, (_, index) => addDaysToDateText(date, index * 7));
  const bandRef = db.collection("bands").doc(bandId);
  const reservationRefs = dates.map(() => db.collection("reservations").doc());
  const repeatGroupId = repeatWeeks > 1 ? crypto.randomUUID() : "";
  let reservationBandName = "";
  const slots = Array.from({ length: endHour - startHour }, (_, index) => startHour + index);

  await db.runTransaction(async (transaction) => {
    const band = await transaction.get(bandRef);
    if (!band.exists || !band.data().active) {
      throw new HttpsError("not-found", "예약할 밴드를 찾을 수 없습니다.");
    }
    const roomDoc = await transaction.get(db.collection("settings").doc("room"));
    const room = roomDoc.exists ? roomDoc.data() : DEFAULT_ROOM_SETTINGS;
    if (room.slotMinutes !== 60 || startHour < room.openHour || endHour > room.closeHour) {
      throw new HttpsError("failed-precondition", "운영 시간 안에서 한 시간 단위로 예약해 주세요.");
    }

    const slotEntries = dates.flatMap((reservationDate, repeatIndex) => slots.map((hour) => ({
      date: reservationDate,
      hour,
      repeatIndex,
      reference: db.collection("scheduleSlots").doc(slotId(reservationDate, hour)),
    })));
    const occupiedSlots = await transaction.getAll(...slotEntries.map((entry) => entry.reference));
    const occupiedDates = [...new Set(occupiedSlots.map((snapshot, index) => snapshot.exists ? slotEntries[index].date : "").filter(Boolean))];
    if (occupiedDates.length) {
      throw new HttpsError("already-exists", `${occupiedDates.map(reservationDateLabel).join(", ")}에 이미 다른 예약이 있습니다. 반복 예약 전체가 저장되지 않았습니다.`);
    }

    const bandData = band.data();
    reservationBandName = String(bandData.name || "예약 밴드");
    dates.forEach((reservationDate, repeatIndex) => {
      transaction.set(reservationRefs[repeatIndex], {
        bandId,
        bandName: bandData.name,
        bandColor: bandData.color || "#8B5CF6",
        date: reservationDate,
        startHour,
        endHour,
        startAt: Timestamp.fromDate(parseReservationDate(reservationDate, startHour)),
        endAt: Timestamp.fromDate(parseReservationDate(reservationDate, endHour)),
        status: "confirmed",
        repeatGroupId,
        repeatIndex,
        repeatCount: repeatWeeks,
        note,
        createdBy: auth.uid,
        createdByName: profile.displayName,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    slotEntries.forEach((entry) => transaction.set(entry.reference, {
      reservationId: reservationRefs[entry.repeatIndex].id,
      date: entry.date,
      hour: entry.hour,
      bandId,
      repeatGroupId,
      createdAt: FieldValue.serverTimestamp(),
    }));
  });

  await sendPushToBand(bandId, {
    title: repeatWeeks > 1 ? `합주실 반복 예약 ${repeatWeeks}회 완료` : "합주실 예약 완료",
    body: `${reservationBandName} · ${reservationDateLabel(date)}부터 ${repeatWeeks > 1 ? "매주 " : ""}${displayTime(startHour)}–${displayTime(endHour)}${repeatWeeks > 1 ? " · 한 달(4주)" : ` · ${trashTitleForDate(date)}`}`,
    kind: "reservation_created",
    reservationId: reservationRefs[0].id,
    url: "./#schedule",
    urgent: true,
  }).catch((error) => console.error("Could not send reservation confirmation push", error));

  return { reservationId: reservationRefs[0].id, reservationIds: reservationRefs.map((reference) => reference.id), repeatCount: repeatWeeks };
});
exports.updateReservation = onCall(async (request) => {
  const auth = requireAuth(request);
  const profile = await getProfile(auth.uid);
  const reservationId = String(request.data?.reservationId || "");
  if (!reservationId) badRequest("수정할 예약 정보가 없습니다.");
  const { date, startHour, endHour } = validateReservationInput(request.data || {});
  const note = validateReservationNote(request.data?.note);
  const requestedScope = String(request.data?.scope || "single");
  if (!["single", "series"].includes(requestedScope)) badRequest("반복 예약 수정 범위를 확인해 주세요.");

  const targetRef = db.collection("reservations").doc(reservationId);
  const targetSnapshot = await targetRef.get();
  if (!targetSnapshot.exists || targetSnapshot.data().status !== "confirmed") {
    throw new HttpsError("not-found", "수정할 활성 예약을 찾지 못했습니다.");
  }
  const target = targetSnapshot.data();
  if (profile.role !== "main_admin" && target.bandId !== profile.bandId) {
    throw new HttpsError("permission-denied", "자신의 밴드 예약만 수정할 수 있습니다.");
  }
  if (String(target.date || "") < dateInSeoul()) {
    throw new HttpsError("failed-precondition", "지난 예약은 수정할 수 없습니다.");
  }

  const editSeries = requestedScope === "series" && target.repeatGroupId && Number(target.repeatCount || 1) > 1;
  let sourceSnapshots = [targetSnapshot];
  if (editSeries) {
    const seriesSnapshot = await db.collection("reservations")
      .where("repeatGroupId", "==", target.repeatGroupId)
      .get();
    sourceSnapshots = seriesSnapshot.docs.filter((snapshot) => {
      const reservation = snapshot.data();
      return reservation.status === "confirmed" && String(reservation.date || "") >= dateInSeoul();
    });
  }
  if (!sourceSnapshots.length) throw new HttpsError("not-found", "수정할 예약을 찾지 못했습니다.");

  const dateOffset = editSeries ? dateDifferenceInDays(target.date, date) : 0;
  const plans = sourceSnapshots.map((snapshot) => {
    const reservation = snapshot.data();
    if (reservation.bandId !== target.bandId) {
      throw new HttpsError("failed-precondition", "반복 예약 정보가 올바르지 않습니다.");
    }
    const nextDate = editSeries ? addDaysToDateText(reservation.date, dateOffset) : date;
    validateReservationInput({ date: nextDate, startHour, endHour });
    return {
      id: snapshot.id,
      ref: snapshot.ref,
      originalDate: reservation.date,
      originalStartHour: Number(reservation.startHour),
      originalEndHour: Number(reservation.endHour),
      nextDate,
      bandId: reservation.bandId,
      repeatGroupId: String(reservation.repeatGroupId || ""),
    };
  });

  const roomSnapshot = await db.collection("settings").doc("room").get();
  const room = roomSnapshot.exists ? roomSnapshot.data() : DEFAULT_ROOM_SETTINGS;
  if (room.slotMinutes !== 60 || startHour < room.openHour || endHour > room.closeHour) {
    throw new HttpsError("failed-precondition", "운영 시간 안에서 한 시간 단위로 예약해 주세요.");
  }

  await db.runTransaction(async (transaction) => {
    const freshReservations = await transaction.getAll(...plans.map((plan) => plan.ref));
    freshReservations.forEach((snapshot, index) => {
      const plan = plans[index];
      const reservation = snapshot.data() || {};
      if (!snapshot.exists || reservation.status !== "confirmed"
        || reservation.date !== plan.originalDate
        || Number(reservation.startHour) !== plan.originalStartHour
        || Number(reservation.endHour) !== plan.originalEndHour) {
        throw new HttpsError("aborted", "예약 정보가 변경되었습니다. 새로고침 후 다시 시도해 주세요.");
      }
    });

    const oldEntries = plans.flatMap((plan) => Array.from(
      { length: plan.originalEndHour - plan.originalStartHour },
      (_, index) => ({
        plan,
        hour: plan.originalStartHour + index,
        ref: db.collection("scheduleSlots").doc(slotId(plan.originalDate, plan.originalStartHour + index)),
      }),
    ));
    const newEntries = plans.flatMap((plan) => Array.from(
      { length: endHour - startHour },
      (_, index) => ({
        plan,
        hour: startHour + index,
        ref: db.collection("scheduleSlots").doc(slotId(plan.nextDate, startHour + index)),
      }),
    ));
    const slotRefsByPath = new Map([...oldEntries, ...newEntries].map((entry) => [entry.ref.path, entry.ref]));
    const slotRefs = [...slotRefsByPath.values()];
    const slotSnapshots = await transaction.getAll(...slotRefs);
    const slotByPath = new Map(slotSnapshots.map((snapshot) => [snapshot.ref.path, snapshot]));
    const editedIds = new Set(plans.map((plan) => plan.id));
    const conflictingDates = [...new Set(newEntries.map((entry) => {
      const snapshot = slotByPath.get(entry.ref.path);
      return snapshot?.exists && !editedIds.has(String(snapshot.data().reservationId || "")) ? entry.plan.nextDate : "";
    }).filter(Boolean))];
    if (conflictingDates.length) {
      throw new HttpsError("already-exists", `${conflictingDates.map(reservationDateLabel).join(", ")}에 이미 다른 예약이 있습니다.`);
    }

    const nextPaths = new Set(newEntries.map((entry) => entry.ref.path));
    oldEntries.forEach((entry) => {
      const snapshot = slotByPath.get(entry.ref.path);
      if (!nextPaths.has(entry.ref.path) && snapshot?.exists && editedIds.has(String(snapshot.data().reservationId || ""))) {
        transaction.delete(entry.ref);
      }
    });
    plans.forEach((plan) => transaction.update(plan.ref, {
      date: plan.nextDate,
      startHour,
      endHour,
      startAt: Timestamp.fromDate(parseReservationDate(plan.nextDate, startHour)),
      endAt: Timestamp.fromDate(parseReservationDate(plan.nextDate, endHour)),
      note,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: auth.uid,
    }));
    newEntries.forEach((entry) => transaction.set(entry.ref, {
      reservationId: entry.plan.id,
      date: entry.plan.nextDate,
      hour: entry.hour,
      bandId: entry.plan.bandId,
      repeatGroupId: entry.plan.repeatGroupId,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }));
  });

  const reminderBatch = db.batch();
  plans.forEach((plan) => PUSH_REMINDER_DEFINITIONS.forEach((definition) => {
    reminderBatch.delete(db.collection("pushReminderDeliveries").doc(`${plan.id}_${definition.key}`));
  }));
  await reminderBatch.commit();

  await sendPushToBand(target.bandId, {
    title: plans.length > 1 ? "합주실 반복 예약 변경" : "합주실 예약 변경",
    body: `${target.bandName} · ${reservationDateLabel(date)} ${displayTime(startHour)}–${displayTime(endHour)}${plans.length > 1 ? ` · ${plans.length}회 반영` : ""}`,
    kind: "reservation_updated",
    reservationId,
    url: "./#schedule",
    urgent: true,
  }).catch((error) => console.error("Could not send reservation update push", error));

  return { updated: true, updatedCount: plans.length };
});
exports.cancelReservation = onCall(async (request) => {
  const auth = requireAuth(request);
  const profile = await getProfile(auth.uid);
  const reservationId = String(request.data?.reservationId || "");
  if (!reservationId) badRequest("예약 정보가 없습니다.");

  const reservationRef = db.collection("reservations").doc(reservationId);
  let cancelledReservation = null;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reservationRef);
    if (!snapshot.exists || snapshot.data().status !== "confirmed") {
      throw new HttpsError("not-found", "취소할 활성 예약을 찾지 못했습니다.");
    }
    const reservation = snapshot.data();
    cancelledReservation = { id: reservationId, ...reservation };
    if (profile.role !== "main_admin" && reservation.bandId !== profile.bandId) {
      throw new HttpsError("permission-denied", "자신의 밴드 예약만 취소할 수 있습니다.");
    }
    const slots = Array.from(
      { length: reservation.endHour - reservation.startHour },
      (_, index) => reservation.startHour + index,
    );
    const slotRefs = slots.map((hour) => db.collection("scheduleSlots").doc(slotId(reservation.date, hour)));
    const slotSnapshots = await Promise.all(slotRefs.map((reference) => transaction.get(reference)));
    transaction.update(reservationRef, {
      status: "cancelled",
      cancelledAt: FieldValue.serverTimestamp(),
      cancelledBy: auth.uid,
    });
    for (let index = 0; index < slotRefs.length; index += 1) {
      if (slotSnapshots[index].exists && slotSnapshots[index].data().reservationId === reservationId) {
        transaction.delete(slotRefs[index]);
      }
    }
  });

  if (cancelledReservation) {
    await sendPushToBand(cancelledReservation.bandId, {
      title: "합주실 예약 취소",
      body: `${cancelledReservation.bandName} · ${reservationDateLabel(cancelledReservation.date)} ${displayTime(cancelledReservation.startHour)}–${displayTime(cancelledReservation.endHour)}`,
      kind: "reservation_cancelled",
      reservationId,
      url: "./#schedule",
      urgent: true,
    }).catch((error) => console.error("Could not send reservation cancellation push", error));
  }
  return { cancelled: true };
});

exports.sendReservationReminders = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Asia/Seoul",
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async () => {
    const now = new Date();
    for (const definition of PUSH_REMINDER_DEFINITIONS) {
      const reservations = await dueReservations(definition, now);
      for (const reservation of reservations) {
        const claim = await claimPushReminder(reservation.id, definition.key);
        if (!claim.claimed) continue;
        try {
          const result = await sendPushToBand(reservation.bandId, reminderPayload(reservation, definition));
          if (!result.attempted) {
            await claim.reference.delete();
            continue;
          }
          await claim.reference.set({
            status: "sent",
            sentAt: FieldValue.serverTimestamp(),
            attempted: result.attempted,
            delivered: result.delivered,
          }, { merge: true });
        } catch (error) {
          console.error(`Could not send ${definition.key} reminder for ${reservation.id}`, error);
          await claim.reference.delete().catch(() => {});
        }
      }
    }
  },
);
