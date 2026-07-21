const { randomUUID } = require("crypto");
const admin = require("firebase-admin");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");

admin.initializeApp();
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

setGlobalOptions({ region: "asia-northeast3", maxInstances: 10 });

const BOOTSTRAP_CODE = defineSecret("BOOTSTRAP_CODE");

const COLORS = ["#8B5CF6", "#0EA5E9", "#10B981", "#F97316", "#EC4899", "#EAB308"];
const DEFAULT_ROOM_SETTINGS = { openHour: 9, closeHour: 23, slotMinutes: 60 };
const LOGIN_ID_PATTERN = /^[가-힣a-z0-9_-]{2,12}$/i;
const INTERNAL_EMAIL_DOMAIN = "@id.soundcheck.local";

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

function displayTime(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
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
  const managerLoginId = normaliseLoginId(request.data?.managerLoginId);
  if (name.length < 2) badRequest("밴드 이름은 두 글자 이상 입력해 주세요.");

  const bandRef = db.collection("bands").doc();
  const inviteRef = db.collection("bandInvites").doc();
  const code = randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
  const expiresAt = Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];

  await db.runTransaction(async (transaction) => {
    transaction.set(bandRef, {
      name,
      managerLoginId,
      managerUid: null,
      color,
      active: true,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: auth.uid,
    });
    transaction.set(inviteRef, {
      bandId: bandRef.id,
      bandName: name,
      managerLoginId,
      code,
      status: "pending",
      expiresAt,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: auth.uid,
    });
  });

  return { bandId: bandRef.id, code, expiresAt: expiresAt.toDate().toISOString() };
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

  const bandRef = db.collection("bands").doc(bandId);
  const reservationRef = db.collection("reservations").doc();
  const startAt = Timestamp.fromDate(parseReservationDate(date, startHour));
  const endAt = Timestamp.fromDate(parseReservationDate(date, endHour));
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

    const slotRefs = slots.map((hour) => db.collection("scheduleSlots").doc(slotId(date, hour)));
    const occupiedSlots = await Promise.all(slotRefs.map((reference) => transaction.get(reference)));
    if (occupiedSlots.some((snapshot) => snapshot.exists)) {
      throw new HttpsError("already-exists", "선택한 시간에 이미 다른 예약이 있습니다.");
    }

    const bandData = band.data();
    transaction.set(reservationRef, {
      bandId,
      bandName: bandData.name,
      bandColor: bandData.color || "#8B5CF6",
      date,
      startHour,
      endHour,
      startAt,
      endAt,
      status: "confirmed",
      createdBy: auth.uid,
      createdByName: profile.displayName,
      createdAt: FieldValue.serverTimestamp(),
    });
    for (let index = 0; index < slotRefs.length; index += 1) {
      transaction.set(slotRefs[index], {
        reservationId: reservationRef.id,
        date,
        hour: slots[index],
        bandId,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  });

  return { reservationId: reservationRef.id };
});

exports.cancelReservation = onCall(async (request) => {
  const auth = requireAuth(request);
  const profile = await getProfile(auth.uid);
  const reservationId = String(request.data?.reservationId || "");
  if (!reservationId) badRequest("예약 정보가 없습니다.");

  const reservationRef = db.collection("reservations").doc(reservationId);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reservationRef);
    if (!snapshot.exists || snapshot.data().status !== "confirmed") {
      throw new HttpsError("not-found", "취소할 활성 예약을 찾지 못했습니다.");
    }
    const reservation = snapshot.data();
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

  return { cancelled: true };
});
