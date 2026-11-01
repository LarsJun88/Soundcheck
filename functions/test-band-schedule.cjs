const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

let profile;
let filters = [];
let writes = 0;
const targetEvent = { bandId: "band-b", title: "Private B", date: "2026-11-01" };
function snapshot(data, id = "event-b") { return { id, exists: Boolean(data), data: () => data }; }
const db = {
  collection(name) {
    const query = {
      where(field, op, value) { filters.push({ name, field, op, value }); return query; },
      async get() {
        if (name === "bands") return { docs: [snapshot({ name: "A" }, "band-a"), snapshot({ name: "B" }, "band-b")] };
        const band = filters.find((item) => item.name === name && item.field === "bandId");
        return { docs: band?.value === "band-a" ? [] : [snapshot(targetEvent)] };
      },
      doc(id = "new-event") {
        return { id, name, async get() { return snapshot(name === "users" ? profile : targetEvent); } };
      },
    };
    return query;
  },
  async runTransaction(callback) {
    return callback({
      async get(ref) { return snapshot(ref.name === "bands" ? { name: "Band A", active: true } : targetEvent); },
      set() { writes++; }, delete() { writes++; },
    });
  },
};
const firestore = () => db;
firestore.FieldValue = { serverTimestamp: () => "timestamp" };
firestore.Timestamp = {};
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const context = {
  exports: {}, console, Buffer,
  require(name) {
    if (name === "firebase-admin") return { initializeApp() {}, firestore };
    if (name === "firebase-functions/v2/https") return { HttpsError, onCall: (...args) => args.at(-1) };
    if (name === "firebase-functions/v2/scheduler") return { onSchedule: (...args) => args.at(-1) };
    return require(name);
  },
};
vm.runInNewContext(fs.readFileSync(`${__dirname}/index.js`, "utf8"), context);
const api = context.exports;
const memberRequest = (data) => ({ auth: { uid: "member-a" }, data });
async function main() {
  await assert.rejects(api.listBandSchedule({ data: { month: "2026-11" } }), { code: "unauthenticated" });
  profile = { active: true, role: "band_admin", bandId: "band-a" };
  filters = [];
  const memberList = await api.listBandSchedule(memberRequest({ month: "2026-11", bandId: "band-b" }));
  assert.equal(memberList.events.length, 0, "A member cannot read B even when requesting B");
  assert.equal(filters.find((item) => item.field === "bandId").value, "band-a");
  await assert.rejects(api.saveBandScheduleEvent(memberRequest({ id: "event-b", bandId: "band-b", title: "Changed", date: "2026-11-01" })), { code: "permission-denied" });
  await assert.rejects(api.deleteBandScheduleEvent(memberRequest({ id: "event-b" })), { code: "permission-denied" });
  assert.equal(writes, 0, "Cross-band mutations never write");
  await api.saveBandScheduleEvent(memberRequest({ title: "New", date: "2026-11-02" }));
  assert.equal(writes, 1);
  profile = { active: true, role: "main_admin" };
  filters = [];
  const adminList = await api.listBandSchedule(memberRequest({ month: "2026-11" }));
  assert.equal(adminList.events.length, 1);
  assert.equal(adminList.bands.length, 2);
  await api.deleteBandScheduleEvent(memberRequest({ id: "event-b" }));
  assert.equal(writes, 2);
  profile = { active: false, role: "band_admin", bandId: "band-a" };
  await assert.rejects(api.listBandSchedule(memberRequest({ month: "2026-11" })), { code: "permission-denied" });
  console.log("Band calendar access tests passed: guest/inactive denied, cross-band read/write/delete denied, own create and admin access allowed.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
