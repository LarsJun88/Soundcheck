const { randomUUID } = require("crypto");
const admin = require("firebase-admin");
const { logger } = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");

admin.initializeApp();
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

setGlobalOptions({ region: "asia-northeast3", maxInstances: 10 });

const BOOTSTRAP_CODE = defineSecret("BOOTSTRAP_CODE");
const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");
const TELEGRAM_BOT_USERNAME = defineSecret("TELEGRAM_BOT_USERNAME");
const TELEGRAM_WEBHOOK_SECRET = defineSecret("TELEGRAM_WEBHOOK_SECRET");

const COLORS = ["#8B5CF6", "#0EA5E9", "#10B981", "#F97316", "#EC4899", "#EAB308"];
const DEFAULT_ROOM_SETTINGS = { openHour: 9, closeHour: 23, slotMinutes: 60 };

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

function normaliseEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    badRequest("올바른 관리자 이메일을 입력해 주세요.");
  }
  return email;
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

async function sendTelegramMessage(chatId, text) {
  const token = TELEGRAM_BOT_TOKEN.value();
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN secret is not configured.");
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed (${response.status}): ${await response.text()}`);
  }
}

exports.bootstrapMainAdmin = onCall(
  { secrets: [BOOTSTRAP_CODE] },
  async (request) => {
    const auth = requireAuth(request);
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
        email: auth.token.email || "",
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
  const managerEmail = normaliseEmail(request.data?.managerEmail);
  if (name.length < 2) badRequest("밴드 이름은 두 글자 이상 입력해 주세요.");

  const bandRef = db.collection("bands").doc();
  const inviteRef = db.collection("bandInvites").doc();
  const code = randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
  const expiresAt = Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];

  await db.runTransaction(async (transaction) => {
    transaction.set(bandRef, {
      name,
      managerEmail,
      managerUid: null,
      color,
      active: true,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: auth.uid,
    });
    transaction.set(inviteRef, {
      bandId: bandRef.id,
      bandName: name,
      managerEmail,
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
  const email = normaliseEmail(auth.token.email);
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
    if (invite.managerEmail !== email) {
      throw new HttpsError("permission-denied", "초대받은 이메일 계정으로 로그인해 주세요.");
    }

    const bandRef = db.collection("bands").doc(invite.bandId);
    const bandSnapshot = await transaction.get(bandRef);
    if (!bandSnapshot.exists || !bandSnapshot.data().active) {
      throw new HttpsError("failed-precondition", "현재 사용할 수 없는 밴드입니다.");
    }
    bandName = bandSnapshot.data().name;
    transaction.set(userRef, {
      displayName,
      email,
      role: "band_admin",
      bandId: invite.bandId,
      active: true,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.update(bandRef, { managerUid: auth.uid, managerEmail: email, activatedAt: FieldValue.serverTimestamp() });
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

exports.createTelegramLink = onCall(
  { secrets: [TELEGRAM_BOT_USERNAME] },
  async (request) => {
    const auth = requireAuth(request);
    await getProfile(auth.uid);
    const botUsername = String(TELEGRAM_BOT_USERNAME.value() || "").replace(/^@/, "").trim();
    if (!botUsername) {
      throw new HttpsError("failed-precondition", "텔레그램 봇이 아직 설정되지 않았습니다.");
    }
    const token = randomUUID().replace(/-/g, "");
    await db.collection("telegramLinks").doc(token).set({
      uid: auth.uid,
      expiresAt: Timestamp.fromDate(new Date(Date.now() + 15 * 60 * 1000)),
      createdAt: FieldValue.serverTimestamp(),
    });
    return { url: `https://t.me/${botUsername}?start=${token}`, expiresInMinutes: 15 };
  },
);

exports.telegramWebhook = onRequest(
  { secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET] },
  async (request, response) => {
    const expectedSecret = TELEGRAM_WEBHOOK_SECRET.value();
    if (expectedSecret && request.get("X-Telegram-Bot-Api-Secret-Token") !== expectedSecret) {
      response.status(403).json({ ok: false });
      return;
    }
    const message = request.body?.message;
    const text = String(message?.text || "");
    const match = text.match(/^\/start(?:@\w+)?\s+([A-Za-z0-9]{32})/);
    const chatId = message?.chat?.id;
    if (!match || !chatId) {
      response.status(200).json({ ok: true });
      return;
    }

    const linkRef = db.collection("telegramLinks").doc(match[1]);
    let linked = false;
    await db.runTransaction(async (transaction) => {
      const link = await transaction.get(linkRef);
      if (!link.exists || link.data().expiresAt.toDate() < new Date()) return;
      transaction.update(db.collection("users").doc(link.data().uid), {
        telegramChatId: String(chatId),
        telegramLinkedAt: FieldValue.serverTimestamp(),
      });
      transaction.delete(linkRef);
      linked = true;
    });

    if (linked) {
      try {
        await sendTelegramMessage(chatId, "합주실 예약 알림이 연결되었습니다. 예약 1일 전과 1시간 전에 알려드릴게요.");
      } catch (error) {
        logger.error("Telegram connection confirmation failed", error);
      }
    }
    response.status(200).json({ ok: true });
  },
);

async function claimReminder(reservationId, type) {
  const reference = db.collection("notificationClaims").doc(`${reservationId}_${type}`);
  let claimed = false;
  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(reference);
    if (existing.exists) return;
    transaction.set(reference, { reservationId, type, claimedAt: FieldValue.serverTimestamp() });
    claimed = true;
  });
  return claimed;
}

exports.sendReservationReminders = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Asia/Seoul",
    secrets: [TELEGRAM_BOT_TOKEN],
  },
  async () => {
    const now = Date.now();
    const windows = [
      { type: "day", minMinutes: 23 * 60 + 45, maxMinutes: 24 * 60 + 15, label: "내일" },
      { type: "hour", minMinutes: 45, maxMinutes: 75, label: "1시간 후" },
    ];

    for (const window of windows) {
      const startAt = Timestamp.fromMillis(now + window.minMinutes * 60 * 1000);
      const endAt = Timestamp.fromMillis(now + window.maxMinutes * 60 * 1000);
      const snapshot = await db.collection("reservations")
        .where("startAt", ">=", startAt)
        .where("startAt", "<=", endAt)
        .get();

      for (const document of snapshot.docs) {
        const reservation = document.data();
        if (reservation.status !== "confirmed") continue;
        const band = await db.collection("bands").doc(reservation.bandId).get();
        if (!band.exists || !band.data().managerUid) continue;
        const manager = await db.collection("users").doc(band.data().managerUid).get();
        const chatId = manager.exists ? manager.data().telegramChatId : null;
        if (!chatId || !(await claimReminder(document.id, window.type))) continue;

        const text = [
          `🎸 합주실 예약 ${window.label} 알림`,
          `${reservation.bandName} · ${reservation.date}`,
          `${displayTime(reservation.startHour)}–${displayTime(reservation.endHour)} 합주 예정입니다.`,
        ].join("\n");
        try {
          await sendTelegramMessage(chatId, text);
          await db.collection("notificationClaims").doc(`${document.id}_${window.type}`).update({
            sentAt: FieldValue.serverTimestamp(),
            status: "sent",
          });
        } catch (error) {
          logger.error("Reservation reminder could not be delivered", { reservationId: document.id, type: window.type, error });
          await db.collection("notificationClaims").doc(`${document.id}_${window.type}`).update({
            status: "failed",
            failedAt: FieldValue.serverTimestamp(),
          });
        }
      }
    }
  },
);
