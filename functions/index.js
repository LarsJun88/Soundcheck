const admin = require("firebase-admin");
const sharp = require("sharp");
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
const MAX_LOGO_ORIGINAL_DATA_URL_LENGTH = 780000;
const MAX_LOGO_THUMBNAIL_DATA_URL_LENGTH = 90000;
const LOGO_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

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
