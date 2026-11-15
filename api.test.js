import dotenv from 'dotenv';
dotenv.config();
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import http from 'node:http';
import mongoose from 'mongoose';
import app from '../src/app.js';
import { calculateDistanceKm, estimateEtaMinutes, formatDistance } from '../src/utils/distance.js';
import User from '../src/models/User.js';
import Incident from '../src/models/Incident.js';
import Hospital from '../src/models/Hospital.js';
import jwt from 'jsonwebtoken';
import { connectDB } from '../src/config/db.js';
import { sendSmsAlert } from '../src/services/smsService.js';
import Responder from '../src/models/Responder.js';
import { checkAndEscalateOverdueIncidents } from '../src/services/escalationService.js';
import { mapCategoryToServiceType } from '../src/services/assignmentService.js';
import { ALL_EMERGENCY_CATEGORIES } from '../src/controllers/incidentController.js';
import ReliefRequest from '../src/models/ReliefRequest.js';
import Volunteer from '../src/models/Volunteer.js';
import ReliefResource from '../src/models/ReliefResource.js';
import { getJwtSecret } from '../src/config/security.js';

const servers = new Set();
const listen = async () => {
  const server = http.createServer(app);
  servers.add(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
};
after(async () => {
  await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))));
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
});

describe('Emergency360 safe backend checks', () => {
  it('requires a configured, nontrivial JWT signing secret', () => {
    const original = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      assert.throws(() => getJwtSecret(), /at least 32 random characters/);
      process.env.JWT_SECRET = 'emergency360_super_secret_jwt_key_2026_secure_hash';
      assert.throws(() => getJwtSecret(), /at least 32 random characters/);
    } finally {
      if (original === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = original;
    }
  });

  it('calculates geographic distances and ETA', () => {
    const distance = calculateDistanceKm(51.5074, -0.1278, 48.8566, 2.3522);
    assert.ok(distance >= 340 && distance <= 346);
    assert.equal(estimateEtaMinutes(4), 6);
    assert.equal(formatDistance(0.45), '450 m');
    assert.equal(formatDistance(3.72), '3.7 km');
  });

  it('hashes passwords and rejects mismatches', async () => {
    const hash = await User.hashPassword('a-unique-test-password');
    const user = new User({ passwordHash: hash });
    assert.equal(await user.comparePassword('a-unique-test-password'), true);
    assert.equal(await user.comparePassword('wrong-password'), false);
  });

  it('validates incident GPS and has a per-citizen offline retry key', async () => {
    const incident = new Incident({
      citizenId: new mongoose.Types.ObjectId(), category: 'medical',
      clientRequestId: 'offline-request-123',
      location: { latitude: 19.88, longitude: 75.34 },
    });
    await incident.validate();
    const indexes = Incident.schema.indexes();
    assert.ok(indexes.some(([keys, options]) => keys.citizenId === 1 && keys.clientRequestId === 1 && options.unique));
    const invalid = new Incident({
      citizenId: new mongoose.Types.ObjectId(), category: 'medical',
      location: { latitude: 91, longitude: 75.34 },
    });
    await assert.rejects(invalid.validate(), mongoose.Error.ValidationError);
  });

  it('does not claim an SMS was sent when the provider is unconfigured', async () => {
    const original = { sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN, phone: process.env.TWILIO_PHONE_NUMBER };
    delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_PHONE_NUMBER;
    try {
      const result = await sendSmsAlert({ to: '+14155552671', body: 'Test' });
      assert.equal(result.success, false);
      assert.equal(result.mode, 'unconfigured');
    } finally {
      for (const [key, value] of Object.entries({ TWILIO_ACCOUNT_SID: original.sid, TWILIO_AUTH_TOKEN: original.token, TWILIO_PHONE_NUMBER: original.phone })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it('keeps diagnostics available and promptly explains database outages at login', async () => {
    const base = await listen();
    const root = await fetch(`${base}/api`);
    assert.equal(root.status, 200);
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.com', password: 'password' }),
    });
    if (mongoose.connection.readyState !== 1) {
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.code, 'DATABASE_UNAVAILABLE');
    }
  });

  describe('Hospital Patient Intakes Feature & Security Isolation', () => {
    let base;
    let userHospA, userHospB, userCit, userResp;
    let hospA, hospB;
    let incMedA, incMedB, incPoliceA;
    let tokenHospA, tokenHospB, tokenCit, tokenResp;

    const cleanupIds = {
      users: [],
      hospitals: [],
      incidents: [],
    };

    const makeToken = (id) => jwt.sign({ id }, getJwtSecret(), { expiresIn: '1h' });

    it('sets up isolated test records in MongoDB', async () => {
      base = await listen();
      await connectDB();

      // 1. Create test users
      userHospA = await User.create({
        name: 'Test Hospital Staff A',
        email: `hosp.a.${Date.now()}@emergency360.local`,
        phone: '+919876543210',
        passwordHash: 'dummy_hash',
        role: 'hospital',
      });
      cleanupIds.users.push(userHospA._id);

      userHospB = await User.create({
        name: 'Test Hospital Staff B',
        email: `hosp.b.${Date.now()}@emergency360.local`,
        phone: '+919876543211',
        passwordHash: 'dummy_hash',
        role: 'hospital',
      });
      cleanupIds.users.push(userHospB._id);

      userCit = await User.create({
        name: 'Test Citizen Patient',
        email: `citizen.${Date.now()}@emergency360.local`,
        phone: '+919876543212',
        passwordHash: 'dummy_hash',
        role: 'citizen',
      });
      cleanupIds.users.push(userCit._id);

      userResp = await User.create({
        name: 'Test Responder Driver',
        email: `responder.${Date.now()}@emergency360.local`,
        phone: '+919876543213',
        passwordHash: 'dummy_hash',
        role: 'responder',
      });
      cleanupIds.users.push(userResp._id);

      tokenHospA = makeToken(userHospA._id);
      tokenHospB = makeToken(userHospB._id);
      tokenCit = makeToken(userCit._id);
      tokenResp = makeToken(userResp._id);

      // 2. Create hospitals
      hospA = await Hospital.create({
        name: 'Apex Test Hospital A',
        address: '100 Medical Boulevard A',
        phone: '+91201111111',
        location: { latitude: 19.87, longitude: 75.36 },
        availableBeds: 20,
        totalBeds: 50,
        availableICUBeds: 5,
        totalICUBeds: 10,
        emergencyAvailable: true,
        userId: userHospA._id,
        verifiedAt: new Date(),
      });
      cleanupIds.hospitals.push(hospA._id);

      hospB = await Hospital.create({
        name: 'Metro Test Hospital B',
        address: '200 Health Way B',
        phone: '+91202222222',
        location: { latitude: 19.90, longitude: 75.40 },
        availableBeds: 15,
        totalBeds: 40,
        availableICUBeds: 3,
        totalICUBeds: 8,
        emergencyAvailable: true,
        userId: userHospB._id,
        verifiedAt: new Date(),
      });
      cleanupIds.hospitals.push(hospB._id);

      // 3. Create medical incidents routed to Hospital A and Hospital B
      incMedA = await Incident.create({
        citizenId: userCit._id,
        category: 'medical',
        description: 'Severe cardiac arrest, en route to Hospital A',
        location: { latitude: 19.88, longitude: 75.37, address: 'Scene Point Alpha' },
        status: 'Assigned',
        hospitalId: hospA._id,
        intake: {
          status: 'Pending',
          bedType: 'None',
          notes: 'Cardiac stabilization in progress',
        },
      });
      cleanupIds.incidents.push(incMedA._id);

      incMedB = await Incident.create({
        citizenId: userCit._id,
        category: 'medical',
        description: 'Multi-trauma injury, en route to Hospital B',
        location: { latitude: 19.91, longitude: 75.41, address: 'Scene Point Beta' },
        status: 'Assigned',
        hospitalId: hospB._id,
        intake: {
          status: 'Pending',
          bedType: 'None',
          notes: 'Trauma protocol initiated',
        },
      });
      cleanupIds.incidents.push(incMedB._id);

      // 4. Non-medical incident (police) even if hospitalId is set
      incPoliceA = await Incident.create({
        citizenId: userCit._id,
        category: 'police',
        description: 'Traffic disturbance nearby',
        location: { latitude: 19.87, longitude: 75.36, address: 'Road Crossing' },
        status: 'Assigned',
        hospitalId: hospA._id,
      });
      cleanupIds.incidents.push(incPoliceA._id);
    });

    it('rejects unauthorized requests (no token, citizen token, or responder token)', async () => {
      // Missing token -> 401
      const resAnon = await fetch(`${base}/api/hospitals/intakes`);
      assert.equal(resAnon.status, 401);

      // Citizen token -> 403 Forbidden
      const resCit = await fetch(`${base}/api/hospitals/intakes`, {
        headers: { Authorization: `Bearer ${tokenCit}` },
      });
      assert.equal(resCit.status, 403);

      // Responder token -> 403 Forbidden
      const resResp = await fetch(`${base}/api/hospitals/intakes`, {
        headers: { Authorization: `Bearer ${tokenResp}` },
      });
      assert.equal(resResp.status, 403);
    });

    it('strictly isolates medical patient intakes to the authenticated hospital facility', async () => {
      // Query Hospital A intakes
      const resA = await fetch(`${base}/api/hospitals/intakes`, {
        headers: { Authorization: `Bearer ${tokenHospA}` },
      });
      assert.equal(resA.status, 200);
      const dataA = await resA.json();
      assert.equal(dataA.success, true);
      assert.equal(dataA.hospital._id, hospA._id.toString());

      // Hospital A must see incMedA
      const idsA = dataA.data.map((i) => i._id);
      assert.ok(idsA.includes(incMedA._id.toString()), 'Hospital A should receive its routed incident');

      // Hospital A must NEVER see Hospital B incidents (incMedB)
      assert.ok(!idsA.includes(incMedB._id.toString()), 'Hospital A must NOT see Hospital B medical records');

      // Hospital A must NEVER see non-medical incidents (incPoliceA)
      assert.ok(!idsA.includes(incPoliceA._id.toString()), 'Hospital intakes must only contain medical incidents');

      // Verify Hospital B isolation
      const resB = await fetch(`${base}/api/hospitals/intakes`, {
        headers: { Authorization: `Bearer ${tokenHospB}` },
      });
      assert.equal(resB.status, 200);
      const dataB = await resB.json();
      const idsB = dataB.data.map((i) => i._id);
      assert.ok(idsB.includes(incMedB._id.toString()), 'Hospital B should receive its routed incident');
      assert.ok(!idsB.includes(incMedA._id.toString()), 'Hospital B must NOT see Hospital A medical records');
    });

    it('prevents cross-hospital intake triage updates with 403 Forbidden', async () => {
      // Hospital A attempts to update Hospital B's patient intake
      const resCross = await fetch(`${base}/api/hospitals/intakes/${incMedB._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenHospA}`,
        },
        body: JSON.stringify({
          status: 'Admitted_ER',
          bedType: 'General',
          notes: 'Illegal cross-facility update attempt',
        }),
      });
      assert.equal(resCross.status, 403);
      const bodyCross = await resCross.json();
      assert.equal(bodyCross.success, false);
      assert.match(bodyCross.message, /Forbidden.*your hospital facility/i);
    });

    it('validates admission status and bed triage inputs', async () => {
      // Invalid status -> 400
      const resInvalidStatus = await fetch(`${base}/api/hospitals/intakes/${incMedA._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenHospA}`,
        },
        body: JSON.stringify({ status: 'InvalidAdmissionState' }),
      });
      assert.equal(resInvalidStatus.status, 400);

      // Invalid bed type -> 400
      const resInvalidBed = await fetch(`${base}/api/hospitals/intakes/${incMedA._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenHospA}`,
        },
        body: JSON.stringify({ bedType: 'Sofa' }),
      });
      assert.equal(resInvalidBed.status, 400);
    });

    it('successfully admits patient, allocates ICU bed, and synchronizes capacity', async () => {
      const initialHosp = await Hospital.findById(hospA._id);
      const initialICU = initialHosp.availableICUBeds;

      // Hospital A admits patient into ICU
      const resAdmit = await fetch(`${base}/api/hospitals/intakes/${incMedA._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenHospA}`,
        },
        body: JSON.stringify({
          status: 'Admitted_ICU',
          bedType: 'ICU',
          notes: 'Admitted into ICU Trauma Bay 1. Intubation stable.',
        }),
      });
      assert.equal(resAdmit.status, 200);
      const admitBody = await resAdmit.json();
      assert.equal(admitBody.success, true);
      assert.equal(admitBody.data.status, 'Admitted_ICU');
      assert.equal(admitBody.data.bedType, 'ICU');
      assert.equal(admitBody.data.notes, 'Admitted into ICU Trauma Bay 1. Intubation stable.');

      // Check database: available ICU beds decremented by 1
      const updatedHosp = await Hospital.findById(hospA._id);
      assert.equal(updatedHosp.availableICUBeds, initialICU - 1);

      // Now discharge: Treated_and_Released
      const resDischarge = await fetch(`${base}/api/hospitals/intakes/${incMedA._id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenHospA}`,
        },
        body: JSON.stringify({
          status: 'Treated_and_Released',
          notes: 'Patient successfully stabilized and discharged.',
        }),
      });
      assert.equal(resDischarge.status, 200);

      // Check database: available ICU beds restored
      const restoredHosp = await Hospital.findById(hospA._id);
      assert.equal(restoredHosp.availableICUBeds, initialICU);

      // Check incident overall status marked Resolved
      const resolvedIncident = await Incident.findById(incMedA._id);
      assert.equal(resolvedIncident.status, 'Resolved');
      assert.ok(resolvedIncident.resolvedAt !== null);
    });

    it('cleans up test fixtures', async () => {
      await Incident.deleteMany({ _id: { $in: cleanupIds.incidents } });
      await Hospital.deleteMany({ _id: { $in: cleanupIds.hospitals } });
      await User.deleteMany({ _id: { $in: cleanupIds.users } });
    });
  });

  describe('Portal Authentication, Role Verification & Registration Security', () => {
    const authCleanup = [];

    it('enforces that public registration creates only Citizen accounts even if role is injected', async () => {
      await connectDB();
      const base = await listen();
      const email = `audit_citizen_${Date.now()}@emergency360.local`;
      const res = await fetch(`${base}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Portal Test Citizen',
          email,
          phone: '+14155550199',
          password: 'securePassword123!',
          role: 'admin', // Attempted role injection
        }),
      });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.user.role, 'citizen', 'Public registration must always result in citizen role');
      authCleanup.push(data.user.id);

      // Verify in DB
      const userInDb = await User.findById(data.user.id);
      assert.equal(userInDb.role, 'citizen');
    });

    it('authenticates accounts and provides accurate role identification for all 4 portals', async () => {
      const base = await listen();
      // Test password authentication for each role
      const password = 'TestSecurePassword123!';
      const hash = await User.hashPassword(password);

      const roles = ['citizen', 'admin', 'responder', 'hospital'];
      for (const role of roles) {
        const u = await User.create({
          name: `Test ${role}`,
          email: `portal_${role}_${Date.now()}@emergency360.local`,
          phone: '+14155550123',
          passwordHash: hash,
          role,
          isDemo: false,
        });
        authCleanup.push(u._id);

        const res = await fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: u.email, password }),
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.user.role, role, `Account must return role ${role}`);
        assert.ok(data.token, 'Token must be issued');
      }
    });

    it('rejects authentication with invalid password credentials', async () => {
      const base = await listen();
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nonexistent@emergency360.local', password: 'WrongPassword!' }),
      });
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /invalid/i);
    });

    it('cleans up auth test fixtures', async () => {
      if (authCleanup.length > 0) {
        await User.deleteMany({ _id: { $in: authCleanup } });
      }
    });
  });

  describe('Phase 1: Timeout-Based Escalation System', () => {
    const escCleanup = { users: [], responders: [], incidents: [] };

    let citizenUser, adminUser, respUserA, respUserB;
    let responderA, responderB;

    it('sets up escalation test fixtures', async () => {
      const hash = await User.hashPassword('testPassword123!');
      const ts = Date.now();

      citizenUser = await User.create({
        name: 'Escalation Citizen',
        email: 'cit_' + ts + '@emergency360.local',
        phone: '+14155551001',
        passwordHash: hash,
        role: 'citizen',
        isDemo: false,
      });
      escCleanup.users.push(citizenUser._id);

      adminUser = await User.create({
        name: 'Escalation Admin',
        email: 'adm_' + ts + '@emergency360.local',
        phone: '+14155551002',
        passwordHash: hash,
        role: 'admin',
        isDemo: false,
      });
      escCleanup.users.push(adminUser._id);

      respUserA = await User.create({
        name: 'Unit 101 Driver',
        email: 'respA_' + ts + '@emergency360.local',
        phone: '+14155551003',
        passwordHash: hash,
        role: 'responder',
        isDemo: false,
      });
      escCleanup.users.push(respUserA._id);

      respUserB = await User.create({
        name: 'Unit 102 Driver',
        email: 'respB_' + ts + '@emergency360.local',
        phone: '+14155551004',
        passwordHash: hash,
        role: 'responder',
        isDemo: false,
      });
      escCleanup.users.push(respUserB._id);

      responderA = await Responder.create({
        userId: respUserA._id,
        serviceType: 'medical',
        unitName: 'Ambulance 101',
        availability: 'available',
        currentLocation: { latitude: 19.88, longitude: 75.34 },
        isDemo: false,
      });
      escCleanup.responders.push(responderA._id);

      responderB = await Responder.create({
        userId: respUserB._id,
        serviceType: 'medical',
        unitName: 'Ambulance 102',
        availability: 'available',
        currentLocation: { latitude: 19.89, longitude: 75.35 },
        isDemo: false,
      });
      escCleanup.responders.push(responderB._id);
    });

    it('does not escalate an incident before timeout threshold', async () => {
      const now = new Date();
      // Assigned 30 seconds ago, threshold 120s
      const inc = await Incident.create({
        citizenId: citizenUser._id,
        category: 'medical',
        status: 'Assigned',
        assignedResponderId: responderA._id,
        assignedAt: new Date(now.getTime() - 30 * 1000),
        location: { latitude: 19.88, longitude: 75.34 },
        isDemo: false,
      });
      escCleanup.incidents.push(inc._id);

      const escalations = await checkAndEscalateOverdueIncidents({ timeoutSeconds: 120, now });
      assert.equal(escalations.length, 0, 'Incident within 30s should not be escalated');

      const checkInc = await Incident.findById(inc._id);
      assert.equal(checkInc.isEscalated, false);
    });

    it('does not escalate an incident that was already Accepted by responder', async () => {
      const now = new Date();
      // Assigned 200s ago, but already Accepted!
      const inc = await Incident.create({
        citizenId: citizenUser._id,
        category: 'medical',
        status: 'Accepted',
        assignedResponderId: responderA._id,
        assignedAt: new Date(now.getTime() - 200 * 1000),
        location: { latitude: 19.88, longitude: 75.34 },
        isDemo: false,
      });
      escCleanup.incidents.push(inc._id);

      const escalations = await checkAndEscalateOverdueIncidents({ timeoutSeconds: 120, now });
      assert.equal(escalations.length, 0, 'Accepted incident must not be escalated');

      const checkInc = await Incident.findById(inc._id);
      assert.equal(checkInc.isEscalated, false);
    });

    it('atomically escalates overdue incident, releases responder, and suggests next candidate', async () => {
      const now = new Date();
      // Mark responderA busy with this assignment
      await Responder.findByIdAndUpdate(responderA._id, {
        $set: { availability: 'busy', assignedIncidentId: null },
      });

      // Assigned 150 seconds ago (exceeds 120s timeout)
      const inc = await Incident.create({
        citizenId: citizenUser._id,
        category: 'medical',
        status: 'Assigned',
        assignedResponderId: responderA._id,
        assignedAt: new Date(now.getTime() - 150 * 1000),
        location: { latitude: 19.88, longitude: 75.34 },
        isDemo: false,
      });
      escCleanup.incidents.push(inc._id);

      await Responder.findByIdAndUpdate(responderA._id, {
        $set: { assignedIncidentId: inc._id },
      });

      const escalations = await checkAndEscalateOverdueIncidents({ timeoutSeconds: 120, now });
      assert.equal(escalations.length, 1, 'Overdue incident must be escalated');

      const esc = escalations[0];
      assert.equal(esc.incident._id.toString(), inc._id.toString());
      assert.equal(esc.timedOutResponder.unitName, 'Ambulance 101');
      assert.equal(esc.releasedResponder, true);

      // Verify incident in DB
      const updatedInc = await Incident.findById(inc._id);
      assert.equal(updatedInc.isEscalated, true);
      assert.ok(updatedInc.escalatedAt);
      assert.match(updatedInc.escalationReason, /Ambulance 101/);

      // Verify responderA was released back to available
      const updatedRespA = await Responder.findById(responderA._id);
      assert.equal(updatedRespA.availability, 'available');
      assert.equal(updatedRespA.assignedIncidentId, null);

      // Verify fallback suggestion includes responderB
      assert.ok(esc.nextCandidates.length >= 1);
      assert.ok(esc.nextCandidates.some((c) => c.responder.unitName === 'Ambulance 102'));
    });

    it('prevents duplicate escalation events on repeated runs', async () => {
      const now = new Date();
      // Running check immediately again with same timestamp
      const duplicateRuns = await checkAndEscalateOverdueIncidents({ timeoutSeconds: 120, now });
      assert.equal(duplicateRuns.length, 0, 'Already escalated incidents must not trigger duplicate events');
    });

    it('does not release a responder who was reassigned to another incident', async () => {
      const now = new Date();
      const anotherIncId = new mongoose.Types.ObjectId();
      // Responder assigned to another valid incident
      await Responder.findByIdAndUpdate(responderB._id, {
        $set: { availability: 'busy', assignedIncidentId: anotherIncId },
      });

      // An old incident still points to responderB, but responderB moved on to anotherIncId
      const staleInc = await Incident.create({
        citizenId: citizenUser._id,
        category: 'medical',
        status: 'Assigned',
        assignedResponderId: responderB._id,
        assignedAt: new Date(now.getTime() - 200 * 1000),
        location: { latitude: 19.88, longitude: 75.34 },
        isDemo: false,
      });
      escCleanup.incidents.push(staleInc._id);

      const escalations = await checkAndEscalateOverdueIncidents({ timeoutSeconds: 120, now });
      assert.equal(escalations.length, 1);
      assert.equal(escalations[0].releasedResponder, false, 'Must not release responder tied to another incident');

      // Verify responderB is STILL busy with anotherIncId
      const checkRespB = await Responder.findById(responderB._id);
      assert.equal(checkRespB.availability, 'busy');
      assert.equal(checkRespB.assignedIncidentId.toString(), anotherIncId.toString());
    });

    it('cleans up escalation test fixtures', async () => {
      await Incident.deleteMany({ _id: { $in: escCleanup.incidents } });
      await Responder.deleteMany({ _id: { $in: escCleanup.responders } });
      await User.deleteMany({ _id: { $in: escCleanup.users } });
    });
  });

  describe('Deactivated User Security & Session Invalidation', () => {
    const deactCleanup = { users: [] };
    let base, activeUser, deactUser, tokenActive, tokenDeact;

    it('sets up active and deactivated users with valid JWTs', async () => {
      base = await listen();
      await connectDB();
      const hash = await User.hashPassword('Password123!');
      const ts = Date.now();

      activeUser = await User.create({
        name: 'Active Citizen',
        email: `active_${ts}@emergency360.local`,
        phone: '+14155553001',
        passwordHash: hash,
        role: 'citizen',
        isActive: true,
      });
      deactCleanup.users.push(activeUser._id);

      deactUser = await User.create({
        name: 'Deactivated Citizen',
        email: `deact_${ts}@emergency360.local`,
        phone: '+14155553002',
        passwordHash: hash,
        role: 'citizen',
        isActive: false,
      });
      deactCleanup.users.push(deactUser._id);

      // Issue tokens
      tokenActive = jwt.sign({ id: activeUser._id }, getJwtSecret(), { expiresIn: '1h' });
      tokenDeact = jwt.sign({ id: deactUser._id }, getJwtSecret(), { expiresIn: '1h' });
    });

    it('allows active users to access protected endpoints with valid JWT', async () => {
      const res = await fetch(`${base}/api/auth/me`, {
        headers: { Authorization: `Bearer ${tokenActive}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.user.email, activeUser.email);
    });

    it('strictly rejects requests from deactivated users presenting previously issued JWT tokens', async () => {
      const res = await fetch(`${base}/api/auth/me`, {
        headers: { Authorization: `Bearer ${tokenDeact}` },
      });
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /deactivated/i);
    });

    it('rejects deactivated user attempts to log in with 403 Forbidden', async () => {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: deactUser.email, password: 'Password123!' }),
      });
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /deactivated/i);
    });

    it('cleans up deactivation test fixtures', async () => {
      await User.deleteMany({ _id: { $in: deactCleanup.users } });
    });
  });

  describe('Admin Account Management, RBAC & Hospital Facility Safeguards', () => {
    const acctCleanup = { users: [], responders: [], hospitals: [] };
    let base, adminUser, nonAdminUser, tokenAdmin, tokenNonAdmin;
    let existingHospital;

    it('sets up admin and non-admin test accounts and fixtures', async () => {
      base = await listen();
      await connectDB();
      const hash = await User.hashPassword('Password123!');
      const ts = Date.now();

      adminUser = await User.create({
        name: 'Managing Admin',
        email: `admin_${ts}@emergency360.local`,
        phone: '+14155554001',
        passwordHash: hash,
        role: 'admin',
        isActive: true,
      });
      acctCleanup.users.push(adminUser._id);

      nonAdminUser = await User.create({
        name: 'Non-Admin User',
        email: `nonadmin_${ts}@emergency360.local`,
        phone: '+14155554002',
        passwordHash: hash,
        role: 'citizen',
        isActive: true,
      });
      acctCleanup.users.push(nonAdminUser._id);

      tokenAdmin = jwt.sign({ id: adminUser._id }, getJwtSecret(), { expiresIn: '1h' });
      tokenNonAdmin = jwt.sign({ id: nonAdminUser._id }, getJwtSecret(), { expiresIn: '1h' });

      existingHospital = await Hospital.create({
        name: `City Safeguard Hospital ${ts}`,
        address: '456 Safe Ave',
        phone: '+14155554999',
        location: { latitude: 19.87, longitude: 75.34 },
        availableBeds: 25,
        totalBeds: 50,
        availableICUBeds: 5,
        totalICUBeds: 10,
        emergencyAvailable: true,
        verifiedAt: new Date(),
      });
      acctCleanup.hospitals.push(existingHospital._id);
    });

    it('enforces RBAC: non-admin users cannot access admin account endpoints', async () => {
      // Unauthenticated -> 401
      const resAnon = await fetch(`${base}/api/admin/accounts`);
      assert.equal(resAnon.status, 401);

      // Citizen token -> 403
      const resCitizen = await fetch(`${base}/api/admin/accounts`, {
        headers: { Authorization: `Bearer ${tokenNonAdmin}` },
      });
      assert.equal(resCitizen.status, 403);
    });

    it('allows authorized admin to create an admin account', async () => {
      const ts = Date.now();
      const res = await fetch(`${base}/api/admin/accounts/admin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenAdmin}`,
        },
        body: JSON.stringify({
          name: 'New Admin Ops',
          email: `new_adm_${ts}@emergency360.local`,
          phone: '+14155555001',
          password: 'SecureAdminPassword123!',
        }),
      });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.data.role, 'admin');
      assert.ok(data.data.user);
      acctCleanup.users.push(data.data.id);
    });

    it('allows authorized admin to create a responder account and vehicle profile', async () => {
      const ts = Date.now();
      const res = await fetch(`${base}/api/admin/accounts/responder`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenAdmin}`,
        },
        body: JSON.stringify({
          name: 'Paramedic Jane',
          email: `paramedic_${ts}@emergency360.local`,
          phone: '+14155555002',
          password: 'SecureRespPassword123!',
          serviceType: 'medical',
          unitName: `Medic Unit ${ts}`,
          vehicleNumber: 'MED-99',
          badgeNumber: 'B-1234',
          latitude: 19.88,
          longitude: 75.35,
        }),
      });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.data.role, 'responder');
      assert.equal(data.data.responderProfile.serviceType, 'medical');
      acctCleanup.users.push(data.data.id);
      acctCleanup.responders.push(data.data.responderProfile._id);
    });

    it('links an unassigned existing hospital facility to a new hospital staff account', async () => {
      const ts = Date.now();
      const res = await fetch(`${base}/api/admin/accounts/hospital`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenAdmin}`,
        },
        body: JSON.stringify({
          name: 'Dr. John Miller',
          email: `dr_miller_${ts}@emergency360.local`,
          phone: '+14155555003',
          password: 'SecureHospPassword123!',
          existingHospitalId: existingHospital._id.toString(),
        }),
      });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.data.hospitalProfile._id, existingHospital._id.toString());
      assert.equal(data.data.hospitalProfile.userId, data.data.id);
      acctCleanup.users.push(data.data.id);

      // Verify in DB that hospital facility now has userId set to Dr. John Miller
      const hospInDb = await Hospital.findById(existingHospital._id);
      assert.equal(hospInDb.userId.toString(), data.data.id.toString());
    });

    it('safeguards against unauthorized facility reassignment when hospital already has active staff', async () => {
      const ts = Date.now();
      // Attempt to reassign existingHospital (which belongs to Dr. John Miller) WITHOUT allowReassign flag
      const res = await fetch(`${base}/api/admin/accounts/hospital`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenAdmin}`,
        },
        body: JSON.stringify({
          name: 'Intruding Dr. Bob',
          email: `dr_bob_${ts}@emergency360.local`,
          phone: '+14155555004',
          password: 'SecureHospPassword123!',
          existingHospitalId: existingHospital._id.toString(),
          // allowReassign is omitted / false
        }),
      });
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.message, /already assigned to active staff.*allowReassign/i);

      // Verify original ownership was preserved
      const hospCheck = await Hospital.findById(existingHospital._id);
      assert.notEqual(hospCheck.userId.toString(), 'intruder');
      // Verify no orphaned user account was left
      const orphanedUser = await User.findOne({ email: `dr_bob_${ts}@emergency360.local` });
      assert.equal(orphanedUser, null);
    });

    it('allows facility reassignment only with explicit administrator authorization flag (allowReassign: true)', async () => {
      const ts = Date.now();
      const res = await fetch(`${base}/api/admin/accounts/hospital`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenAdmin}`,
        },
        body: JSON.stringify({
          name: 'Authorized Successor Dr. Alice',
          email: `dr_alice_${ts}@emergency360.local`,
          phone: '+14155555005',
          password: 'SecureHospPassword123!',
          existingHospitalId: existingHospital._id.toString(),
          allowReassign: true, // Explicit authorization!
        }),
      });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.data.hospitalProfile._id, existingHospital._id.toString());
      assert.equal(data.data.hospitalProfile.userId, data.data.id);
      acctCleanup.users.push(data.data.id);

      // Verify in DB that facility is reassigned to Dr. Alice and audited
      const updatedHosp = await Hospital.findById(existingHospital._id);
      assert.equal(updatedHosp.userId.toString(), data.data.id.toString());
      assert.equal(updatedHosp.lastUpdatedBy.toString(), adminUser._id.toString());
    });

    it('allows admin to toggle account status and prevents deactivating oneself', async () => {
      // Toggle nonAdminUser status
      const resToggle = await fetch(`${base}/api/admin/accounts/${nonAdminUser._id}/status`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      });
      assert.equal(resToggle.status, 200);
      const dataToggle = await resToggle.json();
      assert.equal(dataToggle.success, true);
      assert.equal(dataToggle.data.isActive, false);

      // Attempt self-deactivation -> 400
      const resSelf = await fetch(`${base}/api/admin/accounts/${adminUser._id}/status`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      });
      assert.equal(resSelf.status, 400);
      const dataSelf = await resSelf.json();
      assert.equal(dataSelf.success, false);
      assert.match(dataSelf.message, /cannot deactivate your own/i);
    });

    it('filters managed accounts by role and active/inactive status', async () => {
      // Filter role=hospital
      const resHosp = await fetch(`${base}/api/admin/accounts?role=hospital`, {
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      });
      assert.equal(resHosp.status, 200);
      const dataHosp = await resHosp.json();
      assert.ok(dataHosp.data.every((a) => a.role === 'hospital'));

      // Filter status=inactive
      const resInactive = await fetch(`${base}/api/admin/accounts?role=citizen&status=inactive`, {
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      });
      assert.equal(resInactive.status, 200);
      const dataInactive = await resInactive.json();
      assert.ok(dataInactive.data.some((a) => a._id === nonAdminUser._id.toString()));
    });

    it('cleans up account management test fixtures', async () => {
      await User.deleteMany({ _id: { $in: acctCleanup.users } });
      await Responder.deleteMany({ _id: { $in: acctCleanup.responders } });
      await Hospital.deleteMany({ _id: { $in: acctCleanup.hospitals } });
    });
  });

  describe('Multi-User Public Staff Registration & Admin Approval Workflow', () => {
    const regCleanup = { users: [], responders: [], hospitals: [], incidents: [] };
    let base, adminUser, tokenAdmin;

    it('sets up admin test account', async () => {
      base = await listen();
      await connectDB();
      const hash = await User.hashPassword('AdminPass123!');
      const ts = Date.now();

      adminUser = await User.create({
        name: 'Super Admin',
        email: `super_adm_${ts}@emergency360.local`,
        phone: '+14155556001',
        passwordHash: hash,
        role: 'admin',
        isActive: true,
      });
      regCleanup.users.push(adminUser._id);
      tokenAdmin = jwt.sign({ id: adminUser._id }, getJwtSecret(), { expiresIn: '1h' });
    });

    it('registers a public responder in pending approval state (isActive: false)', async () => {
      const ts = Date.now();
      const res = await fetch(`${base}/api/auth/register-responder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Officer Jack Traven',
          email: `jack_${ts}@emergency360.local`,
          phone: '+14155556002',
          password: 'ResponderPass123!',
          serviceType: 'police',
          unitName: `Patrol Unit ${ts}`,
          vehicleNumber: 'POL-77',
          latitude: 19.88,
          longitude: 75.34,
        }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.data.role, 'responder');
      assert.equal(data.data.isActive, false, 'Public responder must be created in pending approval state');
      assert.equal(data.token, undefined, 'No token should be issued to unapproved responder');
      regCleanup.users.push(data.data.id);
      regCleanup.responders.push(data.data.responderProfile._id);

      // Attempt login before approval -> 403 Forbidden with pending verification message
      const loginRes = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `jack_${ts}@emergency360.local`, password: 'ResponderPass123!' }),
      });
      assert.equal(loginRes.status, 403);
      const loginData = await loginRes.json();
      assert.match(loginData.message, /pending administrator verification/i);

      // Verify unapproved responder is EXCLUDED from dispatch candidates
      const inc = await Incident.create({
        citizenId: adminUser._id,
        category: 'police',
        location: { latitude: 19.88, longitude: 75.34 },
        status: 'Pending',
      });
      regCleanup.incidents.push(inc._id);

      const { findNearestResponders } = await import('../src/services/assignmentService.js'); const nearest = await findNearestResponders(inc);
      assert.ok(
        !nearest.some((c) => c.responder._id.toString() === data.data.responderProfile._id.toString()),
        'Unapproved responder must NOT appear in nearest candidates'
      );

      // Admin approves responder via toggle status
      const approveRes = await fetch(`${base}/api/admin/accounts/${data.data.id}/status`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      });
      assert.equal(approveRes.status, 200);
      const approveData = await approveRes.json();
      assert.equal(approveData.data.isActive, true);

      // Now approved responder CAN log in successfully
      const approvedLogin = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `jack_${ts}@emergency360.local`, password: 'ResponderPass123!' }),
      });
      assert.equal(approvedLogin.status, 200);
      const approvedData = await approvedLogin.json();
      assert.ok(approvedData.token);
    });

    it('registers a public hospital facility in pending verification state (verifiedAt: null)', async () => {
      const ts = Date.now();
      const res = await fetch(`${base}/api/auth/register-hospital`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staffName: 'Dr. Gregory House',
          email: `house_${ts}@emergency360.local`,
          phone: '+14155556003',
          password: 'HospitalPass123!',
          hospitalName: `St. Jude Teaching Hospital ${ts}`,
          address: '777 Healing Way',
          latitude: 19.89,
          longitude: 75.35,
          totalBeds: 100,
          availableBeds: 40,
          totalICUBeds: 20,
          availableICUBeds: 8,
          emergencyAvailable: true,
        }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.data.role, 'hospital');
      assert.equal(data.data.isActive, false);
      assert.equal(data.data.hospitalProfile.verifiedAt, null, 'Hospital facility must be unverified initially');
      assert.equal(data.token, undefined);
      regCleanup.users.push(data.data.id);
      regCleanup.hospitals.push(data.data.hospitalProfile._id);

      // Attempt login before approval -> 403 Forbidden with pending verification message
      const loginRes = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `house_${ts}@emergency360.local`, password: 'HospitalPass123!' }),
      });
      assert.equal(loginRes.status, 403);
      const loginData = await loginRes.json();
      assert.match(loginData.message, /pending administrator verification/i);

      // Verify unverified hospital does NOT appear in public verified hospital directory
      const pubHospRes = await fetch(`${base}/api/hospitals`);
      const pubHospData = await pubHospRes.json();
      assert.ok(
        !pubHospData.data.some((h) => h._id.toString() === data.data.hospitalProfile._id.toString()),
        'Unverified hospital must NOT be publicly listed'
      );

      // Admin approves hospital account via toggle status -> verifies facility automatically
      const approveRes = await fetch(`${base}/api/admin/accounts/${data.data.id}/status`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      });
      assert.equal(approveRes.status, 200);

      // Check DB: Hospital facility verifiedAt was set upon account approval
      const verifiedHospInDb = await Hospital.findById(data.data.hospitalProfile._id);
      assert.ok(verifiedHospInDb.verifiedAt !== null, 'Hospital facility should be verified on approval');

      // Now hospital appears in public verified directory
      const pubHospRes2 = await fetch(`${base}/api/hospitals`);
      const pubHospData2 = await pubHospRes2.json();
      assert.ok(
        pubHospData2.data.some((h) => h._id.toString() === data.data.hospitalProfile._id.toString()),
        'Verified hospital must now appear in public directory'
      );
    });

    it('rejects duplicate email registrations for responders and hospitals', async () => {
      const existingUser = await User.findById(regCleanup.users[0]);
      // Duplicate responder registration with existing email
      const resDupResp = await fetch(`${base}/api/auth/register-responder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Imposter Officer',
          email: existingUser.email,
          phone: '+14155556999',
          password: 'Password123!',
          serviceType: 'police',
          unitName: 'Duplicate Patrol',
        }),
      });
      assert.equal(resDupResp.status, 400);
      const dataDupResp = await resDupResp.json();
      assert.match(dataDupResp.message, /already exists/i);

      // Duplicate hospital registration with existing email
      const resDupHosp = await fetch(`${base}/api/auth/register-hospital`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staffName: 'Imposter Medic',
          email: existingUser.email,
          phone: '+14155556998',
          password: 'Password123!',
          hospitalName: 'Duplicate General Hospital',
          address: '404 Duplicate Way',
        }),
      });
      assert.equal(resDupHosp.status, 400);
      const dataDupHosp = await resDupHosp.json();
      assert.match(dataDupHosp.message, /already exists/i);
    });

    it('safeguards dispatch assignment against unapproved/inactive responders', async () => {
      const ts = Date.now();
      // Register another pending responder
      const regRes = await fetch(`${base}/api/auth/register-responder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Cadet Unapproved',
          email: `cadet_${ts}@emergency360.local`,
          phone: '+14155556888',
          password: 'CadetPassword123!',
          serviceType: 'police',
          unitName: `Cadet Unit ${ts}`,
        }),
      });
      assert.equal(regRes.status, 201);
      const regData = await regRes.json();
      regCleanup.users.push(regData.data.id);
      regCleanup.responders.push(regData.data.responderProfile._id);

      const inc = await Incident.create({
        citizenId: adminUser._id,
        category: 'police',
        location: { latitude: 19.88, longitude: 75.34 },
        status: 'Verified',
      });
      regCleanup.incidents.push(inc._id);

      const { assignResponderToIncident } = await import('../src/services/assignmentService.js');
      await assert.rejects(
        async () => {
          await assignResponderToIncident(inc._id, regData.data.responderProfile._id, adminUser._id);
        },
        /pending approval or inactive/i,
        'Assigning an unapproved responder must throw an error and be rejected'
      );
    });

    it('allows multiple independent responders and hospitals to register with distinct emails and maintains pending approval', async () => {
      const ts1 = Date.now() + 1;
      const ts2 = Date.now() + 2;

      // Register second responder
      const resResp2 = await fetch(`${base}/api/auth/register-responder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Paramedic Sarah Jenkins',
          email: `sarah_${ts1}@emergency360.local`,
          phone: '+14155556111',
          password: 'Password123!',
          serviceType: 'medical',
          unitName: `Medic Unit ${ts1}`,
        }),
      });
      assert.equal(resResp2.status, 201);
      const dataResp2 = await resResp2.json();
      assert.equal(dataResp2.data.isActive, false);
      regCleanup.users.push(dataResp2.data.id);
      regCleanup.responders.push(dataResp2.data.responderProfile._id);

      // Register second independent hospital facility
      const resHosp2 = await fetch(`${base}/api/auth/register-hospital`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staffName: 'Dr. Marcus Welby',
          email: `welby_${ts2}@emergency360.local`,
          phone: '+14155556222',
          password: 'Password123!',
          hospitalName: `Memorial Valley Hospital ${ts2}`,
          address: '888 Recovery Lane',
        }),
      });
      assert.equal(resHosp2.status, 201);
      const dataHosp2 = await resHosp2.json();
      assert.equal(dataHosp2.data.isActive, false);
      assert.equal(dataHosp2.data.hospitalProfile.verifiedAt, null);
      regCleanup.users.push(dataHosp2.data.id);
      regCleanup.hospitals.push(dataHosp2.data.hospitalProfile._id);
    });

    it('cleans up registration test fixtures', async () => {
      await Incident.deleteMany({ _id: { $in: regCleanup.incidents } });
      await Hospital.deleteMany({ _id: { $in: regCleanup.hospitals } });
      await Responder.deleteMany({ _id: { $in: regCleanup.responders } });
      await User.deleteMany({ _id: { $in: regCleanup.users } });
    });
  });

  describe('Personal Emergency Network (PEN) & Multi-Contact Delivery Audit', () => {
    const penCleanup = { users: [], incidents: [] };
    let base, citizenUser, tokenCitizen;

    it('sets up citizen account with Personal Emergency Network preferences', async () => {
      base = await listen();
      await connectDB();
      const hash = await User.hashPassword('CitizenPass123!');
      const ts = Date.now();

      citizenUser = await User.create({
        name: 'PEN Test Citizen',
        email: `pencit_${ts}@emergency360.local`,
        phone: '+14155557001',
        passwordHash: hash,
        role: 'citizen',
        isActive: true,
      });
      penCleanup.users.push(citizenUser._id);
      tokenCitizen = jwt.sign({ id: citizenUser._id }, getJwtSecret(), { expiresIn: '1h' });
    });

    it('manages multiple trusted contacts and consent settings via emergency-network endpoint', async () => {
      // Configure 2 trusted contacts and 90-minute location sharing consent
      const res = await fetch(`${base}/api/auth/emergency-network`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenCitizen}`,
        },
        body: JSON.stringify({
          locationSharingConsent: true,
          locationSharingDurationMinutes: 90,
          emergencyContacts: [
            {
              name: 'Dr. Sarah Connor',
              phone: '+14155557002',
              relationship: 'Mother',
              notifySms: true,
            },
            {
              name: 'Officer John Connor',
              phone: '+14155557003',
              relationship: 'Brother',
              notifySms: true,
            },
          ],
        }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.data.emergencyContacts.length, 2);
      assert.equal(data.data.locationSharingDurationMinutes, 90);

      // Verify GET endpoint returns these contacts
      const getRes = await fetch(`${base}/api/auth/emergency-network`, {
        headers: { Authorization: `Bearer ${tokenCitizen}` },
      });
      assert.equal(getRes.status, 200);
      const getData = await getRes.json();
      assert.equal(getData.data.emergencyContacts.length, 2);
    });

    it('records multi-contact delivery notifications and nearby facilities upon SOS dispatch', async () => {
      const res = await fetch(`${base}/api/incidents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenCitizen}`,
        },
        body: JSON.stringify({
          category: 'medical',
          description: 'Emergency test SOS for Personal Emergency Network',
          location: {
            latitude: 19.88,
            longitude: 75.34,
            address: '100 Emergency Blvd',
          },
        }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);
      penCleanup.incidents.push(data.data._id);

      // Verify contactNotifications array has 2 recipients logged
      assert.equal(data.notifications.contactNotifications.length, 2);
      assert.ok(data.notifications.contactNotifications.some((n) => n.recipientPhone === '+14155557002'));
      assert.ok(data.notifications.contactNotifications.some((n) => n.recipientPhone === '+14155557003'));

      // Check incident record in DB
      const incInDb = await Incident.findById(data.data._id);
      assert.ok(incInDb.locationSharingExpiresAt !== null, 'Location sharing expiration must be set');
      assert.equal(incInDb.contactNotifications.length, 2);
    });

    it('handles retry notifications with audit logging', async () => {
      const incId = penCleanup.incidents[0];

      const retryRes = await fetch(`${base}/api/incidents/${incId}/retry-notification`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenCitizen}`,
        },
        body: JSON.stringify({}),
      });

      assert.equal(retryRes.status, 200);
      const retryData = await retryRes.json();
      assert.equal(retryData.success, true);
      assert.ok(retryData.contactNotifications.every((n) => n.retryCount >= 1));
    });

    it('cleans up PEN test fixtures', async () => {
      await Incident.deleteMany({ _id: { $in: penCleanup.incidents } });
      await User.deleteMany({ _id: { $in: penCleanup.users } });
    });
  });

  describe('Unified 10 Emergency Categories & Secure Live Tracking Sessions', () => {
    let base;
    let tokenCitizen;
    let citizenUser;
    const cleanup = { users: [], incidents: [] };

    it('sets up citizen test account with live tracking consent', async () => {
      await connectDB();
      base = await listen();

      const email = `citizen-live-${Date.now()}@emergency360.test`;
      const passHash = await User.hashPassword('Pass123!Secure');
      citizenUser = await User.create({
        name: 'Live Tracking Citizen',
        email,
        phone: '+14155558801',
        passwordHash: passHash,
        role: 'citizen',
        isActive: true,
        locationSharingConsent: true,
        locationSharingDurationMinutes: 60,
      });
      cleanup.users.push(citizenUser._id);

      tokenCitizen = jwt.sign(
        { id: citizenUser._id, email: citizenUser.email, role: 'citizen' },
        getJwtSecret(),
        { expiresIn: '1h' }
      );
    });

    it('correctly maps all 10 emergency categories to appropriate responder service types', () => {
      assert.equal(mapCategoryToServiceType('road_accident'), 'medical');
      assert.equal(mapCategoryToServiceType('medical'), 'medical');
      assert.equal(mapCategoryToServiceType('fire_explosion'), 'fire');
      assert.equal(mapCategoryToServiceType('flood_rainfall'), 'fire');
      assert.equal(mapCategoryToServiceType('natural_disaster'), 'fire');
      assert.equal(mapCategoryToServiceType('trapped_rescue'), 'fire');
      assert.equal(mapCategoryToServiceType('gas_hazardous'), 'fire');
      assert.equal(mapCategoryToServiceType('women_safety'), 'police');
      assert.equal(mapCategoryToServiceType('missing_person'), 'police');
      assert.equal(mapCategoryToServiceType('other'), 'medical');
      // Legacy backwards compatibility
      assert.equal(mapCategoryToServiceType('fire'), 'fire');
      assert.equal(mapCategoryToServiceType('police'), 'police');
    });

    it('creates an emergency incident with flood_rainfall and non-blocking category details', async () => {
      const res = await fetch(`${base}/api/incidents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenCitizen}`,
        },
        body: JSON.stringify({
          category: 'flood_rainfall',
          affectedCount: 4,
          categoryDetails: {
            waterLevel: 'waist_deep',
            familiesAffected: 2,
            trappedOnRoof: false,
          },
          location: {
            latitude: 19.8912,
            longitude: 75.3344,
            address: 'Riverside Settlement Sector 4',
            accuracy: 12,
          },
        }),
      });

      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.category, 'flood_rainfall');
      assert.equal(body.data.priority, 'High'); // Inferred priority rule
      assert.equal(body.data.affectedCount, 4);
      assert.equal(body.data.categoryDetails.waterLevel, 'waist_deep');
      cleanup.incidents.push(body.data._id);
    });

    it('creates a critical trapped_rescue incident with automatic Critical priority', async () => {
      const res = await fetch(`${base}/api/incidents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenCitizen}`,
        },
        body: JSON.stringify({
          category: 'trapped_rescue',
          affectedCount: 2,
          location: {
            latitude: 19.895,
            longitude: 75.339,
            address: 'Collapsed Building Site',
          },
        }),
      });

      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.priority, 'Critical');
      cleanup.incidents.push(body.data._id);
    });

    it('generates an unpredictable 48-char tracking token for live tracking session', async () => {
      const incId = cleanup.incidents[0];
      const incident = await Incident.findById(incId);
      assert.ok(incident.trackingToken, 'Tracking token must be generated');
      assert.equal(typeof incident.trackingToken, 'string');
      assert.equal(incident.trackingToken.length, 48); // 24 bytes hex = 48 chars
      assert.equal(incident.isLiveTrackingActive, true);
      assert.ok(incident.trackingExpiresAt > new Date());
      assert.equal(incident.liveLocation.latitude, 19.8912);
    });

    it('retrieves sanitized live tracking data by token without exposing sensitive user PII', async () => {
      const incId = cleanup.incidents[0];
      const incident = await Incident.findById(incId);
      const token = incident.trackingToken;

      const res = await fetch(`${base}/api/incidents/tracking/${token}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.category, 'flood_rainfall');
      assert.equal(body.data.liveLocation.latitude, 19.8912);
      // Ensure no passwordHash or internal citizen tokens are leaked
      assert.equal(body.data.passwordHash, undefined);
      assert.equal(body.data.citizenId, undefined);
    });

    it('streams live coordinate updates via token with accuracy and timestamps', async () => {
      const incId = cleanup.incidents[0];
      const incident = await Incident.findById(incId);
      const token = incident.trackingToken;

      const updateRes = await fetch(`${base}/api/incidents/tracking/${token}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          latitude: 19.8925,
          longitude: 75.3358,
          accuracy: 5,
          heading: 180,
          speed: 1.2,
        }),
      });

      assert.equal(updateRes.status, 200);
      const updateData = await updateRes.json();
      assert.equal(updateData.success, true);
      assert.equal(updateData.liveLocation.latitude, 19.8925);
      assert.equal(updateData.liveLocation.longitude, 75.3358);
      assert.equal(updateData.liveLocation.accuracy, 5);

      // Verify in DB
      const updatedInc = await Incident.findById(incId);
      assert.equal(updatedInc.location.latitude, 19.8925);
      assert.equal(updatedInc.location.longitude, 75.3358);
    });

    it('rate-limits continuous coordinate streaming when throttled under 1.5 seconds', async () => {
      const incId = cleanup.incidents[0];
      const incident = await Incident.findById(incId);
      const token = incident.trackingToken;

      // Immediate subsequent call should be throttled
      const throttledRes = await fetch(`${base}/api/incidents/tracking/${token}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          latitude: 19.893,
          longitude: 75.336,
        }),
      });

      assert.equal(throttledRes.status, 429);
      const throttledData = await throttledRes.json();
      assert.equal(throttledData.success, false);
      assert.match(throttledData.message, /Rate limit exceeded/);
    });

    it('allows citizen to stop live location sharing and revokes session access', async () => {
      const incId = cleanup.incidents[0];
      const incident = await Incident.findById(incId);
      const token = incident.trackingToken;

      const stopRes = await fetch(`${base}/api/incidents/${incId}/stop-tracking`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenCitizen}`,
        },
      });

      assert.equal(stopRes.status, 200);
      const stopData = await stopRes.json();
      assert.equal(stopData.success, true);
      assert.equal(stopData.isLiveTrackingActive, false);

      // Subsequent public tracking update should be rejected with 410 Gone (revoked)
      // Wait 1.6s to avoid hitting the 429 rate limiter
      await new Promise((resolve) => setTimeout(resolve, 1600));

      const updateAfterStopRes = await fetch(`${base}/api/incidents/tracking/${token}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          latitude: 19.894,
          longitude: 75.337,
        }),
      });

      assert.equal(updateAfterStopRes.status, 410);
      const updateAfterStopData = await updateAfterStopRes.json();
      assert.equal(updateAfterStopData.isRevoked, true);
    });

    it('rejects access to expired live tracking sessions with 410 Gone', async () => {
      const incId = cleanup.incidents[1];
      // Artificially expire the second incident's tracking session
      await Incident.findByIdAndUpdate(incId, {
        $set: { trackingExpiresAt: new Date(Date.now() - 10000) },
      });

      const expiredInc = await Incident.findById(incId);
      const token = expiredInc.trackingToken;

      const getRes = await fetch(`${base}/api/incidents/tracking/${token}`);
      assert.equal(getRes.status, 410);
      const getData = await getRes.json();
      assert.equal(getData.isExpired, true);
    });

    it('cleans up Phase 2 & 3 test fixtures', async () => {
      await Incident.deleteMany({ _id: { $in: cleanup.incidents } });
      await User.deleteMany({ _id: { $in: cleanup.users } });
    });
  });

  describe('Flood & Disaster Relief, Volunteer/NGO Coordination, Inventory & CSV Export', () => {
    let base;
    let tokenCitizen;
    let tokenAdmin;
    let citizenUser;
    let adminUser;
    let volunteerId;
    let resourceId;
    let reliefRequestId;
    const cleanup = { users: [], reliefRequests: [], volunteers: [], resources: [] };

    it('sets up citizen and admin test accounts for disaster relief operations', async () => {
      await connectDB();
      base = await listen();

      const passHash = await User.hashPassword('Pass123!Secure');
      citizenUser = await User.create({
        name: 'Flood Relief Citizen',
        email: `citizen-relief-${Date.now()}@emergency360.test`,
        phone: '+14155559001',
        passwordHash: passHash,
        role: 'citizen',
        isActive: true,
      });
      cleanup.users.push(citizenUser._id);

      adminUser = await User.create({
        name: 'Relief Coordinator Admin',
        email: `admin-relief-${Date.now()}@emergency360.test`,
        phone: '+14155559002',
        passwordHash: passHash,
        role: 'admin',
        isActive: true,
      });
      cleanup.users.push(adminUser._id);

      tokenCitizen = jwt.sign(
        { id: citizenUser._id, email: citizenUser.email, role: 'citizen' },
        getJwtSecret(),
        { expiresIn: '1h' }
      );

      tokenAdmin = jwt.sign(
        { id: adminUser._id, email: adminUser.email, role: 'admin' },
        getJwtSecret(),
        { expiresIn: '1h' }
      );
    });

    it('submits a flood relief request for drinking water with affected count and location', async () => {
      const res = await fetch(`${base}/api/relief/requests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenCitizen}`,
        },
        body: JSON.stringify({
          category: 'drinking_water',
          urgency: 'Critical',
          affectedPeople: 8,
          affectedFamilies: 2,
          location: {
            latitude: 19.876,
            longitude: 75.321,
            address: 'Submerged Colony, Ward 12, Riverbank',
            district: 'Aurangabad East',
            landmark: 'Near Water Tower',
          },
          specificNeeds: 'Clean drinking water cans and oral rehydration packets needed urgently',
        }),
      });

      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.category, 'drinking_water');
      assert.equal(body.data.status, 'Submitted');
      assert.equal(body.data.affectedPeople, 8);
      reliefRequestId = body.data._id;
      cleanup.reliefRequests.push(reliefRequestId);
    });

    it('rejects duplicate relief requests submitted within 10 minutes with 409 Conflict', async () => {
      const res = await fetch(`${base}/api/relief/requests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenCitizen}`,
        },
        body: JSON.stringify({
          category: 'drinking_water',
          location: {
            latitude: 19.876,
            longitude: 75.321,
            address: 'Submerged Colony, Ward 12',
          },
        }),
      });

      assert.equal(res.status, 409);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.match(body.message, /recently submitted/);
    });

    it('registers a public volunteer/NGO unit in pending approval state (isActive: false)', async () => {
      const email = `volunteer-${Date.now()}@emergency360.test`;
      const res = await fetch(`${base}/api/relief/volunteers/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Vikram Singh',
          email,
          phone: '+14155559003',
          password: 'Password123!Secure',
          organizationName: 'Marathwada Flood Rescue Team',
          type: 'ngo',
          serviceAreas: ['Aurangabad East', 'Jalna Border'],
          skills: ['boat_rescue', 'food_water_distribution'],
          capacity: {
            volunteersCount: 15,
            boatsCount: 3,
            vehiclesCount: 2,
          },
        }),
      });

      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.status, 'pending');
      volunteerId = body.data.volunteerId;
      cleanup.volunteers.push(volunteerId);

      const userInDb = await User.findOne({ email });
      assert.equal(userInDb.isActive, false, 'Pending volunteer must not be active before approval');
      cleanup.users.push(userInDb._id);
    });

    it('prevents assigning unapproved/inactive volunteers to relief missions', async () => {
      const patchRes = await fetch(`${base}/api/relief/requests/${reliefRequestId}/assign`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenAdmin}`,
        },
        body: JSON.stringify({
          volunteerId,
        }),
      });

      assert.equal(patchRes.status, 400);
      const body = await patchRes.json();
      assert.match(body.message, /pending approval or inactive/);
    });

    it('allows admin to approve volunteer/NGO and activates their user account', async () => {
      const res = await fetch(`${base}/api/relief/volunteers/${volunteerId}/approve`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenAdmin}`,
        },
        body: JSON.stringify({ status: 'approved' }),
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.status, 'approved');

      const volunteerDoc = await Volunteer.findById(volunteerId);
      const userDoc = await User.findById(volunteerDoc.userId);
      assert.equal(userDoc.isActive, true, 'Approved volunteer user account must be active');
    });

    it('allows admin to verify relief request (Submitted -> Verified)', async () => {
      const res = await fetch(`${base}/api/relief/requests/${reliefRequestId}/verify`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenAdmin}`,
        },
        body: JSON.stringify({ note: 'Verified by district emergency cell' }),
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.status, 'Verified');
    });

    it('creates relief inventory stock with warehouse tracking', async () => {
      const res = await fetch(`${base}/api/relief/inventory`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenAdmin}`,
        },
        body: JSON.stringify({
          type: 'drinking_water',
          title: '20L Potable Water Cans',
          description: 'Purified mineral drinking water cans for flood zones',
          region: 'Aurangabad East',
          totalQuantity: 200,
          unit: 'cans',
          warehouseLocation: {
            address: 'Central Disaster Relief Depot, Sector 2',
            latitude: 19.88,
            longitude: 75.33,
          },
        }),
      });

      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.totalQuantity, 200);
      resourceId = body.data._id;
      cleanup.resources.push(resourceId);
    });

    it('assigns request to approved volunteer and allocates stock with atomic inventory deduction', async () => {
      const res = await fetch(`${base}/api/relief/requests/${reliefRequestId}/assign`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenAdmin}`,
        },
        body: JSON.stringify({
          volunteerId,
          resourceId,
          allocatedQuantity: 25,
          note: 'Assigned to Marathwada Rescue Team for boat delivery',
        }),
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.status, 'Assigned');
      assert.equal(body.data.allocatedQuantity, 25);

      // Verify inventory deducted in DB
      const resDoc = await ReliefResource.findById(resourceId);
      assert.equal(resDoc.allocatedQuantity, 25);
      assert.equal(resDoc.availableQuantity, 175);
    });

    it('prevents duplicate inventory allocation to the same request', async () => {
      const res = await fetch(`${base}/api/relief/requests/${reliefRequestId}/assign`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenAdmin}`,
        },
        body: JSON.stringify({
          resourceId,
          allocatedQuantity: 10,
        }),
      });

      assert.equal(res.status, 409);
      const body = await res.json();
      assert.match(body.message, /already been allocated/);
    });

    it('progresses status to In Transit and Delivered with confirmed delivery record', async () => {
      // Step 1: In Transit
      const transitRes = await fetch(`${base}/api/relief/requests/${reliefRequestId}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenAdmin}`,
        },
        body: JSON.stringify({ status: 'In Transit', note: 'Boat en route to flooded settlement' }),
      });
      assert.equal(transitRes.status, 200);
      const transitBody = await transitRes.json();
      assert.equal(transitBody.data.status, 'In Transit');

      // Step 2: Delivered
      const deliverRes = await fetch(`${base}/api/relief/requests/${reliefRequestId}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenAdmin}`,
        },
        body: JSON.stringify({
          status: 'Delivered',
          note: '25 water cans delivered to Ward 12 families',
          confirmationCode: 'DELIV-CONF-8899',
        }),
      });
      assert.equal(deliverRes.status, 200);
      const deliverBody = await deliverRes.json();
      assert.equal(deliverBody.data.status, 'Delivered');
      assert.equal(deliverBody.data.deliveryRecord.recipientAcknowledged, true);
      assert.equal(deliverBody.data.deliveryRecord.confirmationCode, 'DELIV-CONF-8899');

      // Verify volunteer is freed back to available
      const volDoc = await Volunteer.findById(volunteerId);
      assert.equal(volDoc.availability, 'available');
    });

    it('exports incident emergency history as CSV with audit details and correct headers', async () => {
      const res = await fetch(`${base}/api/incidents/export/csv`, {
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      });

      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/csv/);
      assert.match(res.headers.get('content-disposition'), /emergency360-incident-history\.csv/);

      const csvText = await res.text();
      assert.ok(csvText.includes('Incident ID'));
      assert.ok(csvText.includes('Category'));
      assert.ok(csvText.includes('Priority'));
      assert.ok(csvText.includes('Resolution Time (Mins)'));
      assert.ok(csvText.includes('PEN Notifications Status'));
    });

    it('creates an emergency relief fundraising campaign and records a verified pledge/contribution', async () => {
      // Create a fund resource
      const fundRes = await fetch(`${base}/api/relief/inventory`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenAdmin}`,
        },
        body: JSON.stringify({
          type: 'fund',
          title: 'Flood Victims Emergency Relief Fund',
          description: 'Emergency aid fund for direct flood victim relief and community rebuilding.',
          region: 'River Valley District',
          amountTarget: 100000,
          currency: 'INR',
        }),
      });

      assert.equal(fundRes.status, 201);
      const fundBody = await fundRes.json();
      assert.equal(fundBody.success, true);
      const fundId = fundBody.data._id;
      cleanup.resources.push(fundId);

      // Attempt donation with invalid amount (0)
      const invalidRes = await fetch(`${base}/api/relief/inventory/${fundId}/donate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 0 }),
      });
      assert.equal(invalidRes.status, 400);

      // Record valid contribution
      const donateRes = await fetch(`${base}/api/relief/inventory/${fundId}/donate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: 2500,
          donorName: 'Generous Citizen',
          donorPhone: '+14155552671',
          message: 'Hope this helps the families in need.',
        }),
      });

      assert.equal(donateRes.status, 200);
      const donateBody = await donateRes.json();
      assert.equal(donateBody.success, true);
      assert.equal(donateBody.data.amountRaised, 2500);
      assert.equal(donateBody.receipt.status, 'pledged');
      assert.equal(donateBody.receipt.gatewayMode, 'unconfigured');
      assert.ok(donateBody.receipt.notice.includes('Payment gateway is unconfigured'));
      const donationId = donateBody.receipt._id;

      // Fetch campaign donations list
      const listRes = await fetch(`${base}/api/relief/inventory/${fundId}/donations`);
      assert.equal(listRes.status, 200);
      const listBody = await listRes.json();
      assert.equal(listBody.success, true);
      assert.equal(listBody.count, 1);
      assert.equal(listBody.data[0].amount, 2500);
      assert.equal(listBody.data[0].donorName, 'Generous Citizen');

      // Admin verifies donation pledge
      const verifyRes = await fetch(`${base}/api/relief/inventory/${fundId}/donations/${donationId}/verify`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokenAdmin}` },
      });
      assert.equal(verifyRes.status, 200);
      const verifyBody = await verifyRes.json();
      assert.equal(verifyBody.success, true);
      assert.equal(verifyBody.data.status, 'verified');
      assert.ok(verifyBody.data.verifiedBy);
    });

    it('cleans up Phase 4 test fixtures', async () => {
      await ReliefRequest.deleteMany({ _id: { $in: cleanup.reliefRequests } });
      await Volunteer.deleteMany({ _id: { $in: cleanup.volunteers } });
      await ReliefResource.deleteMany({ _id: { $in: cleanup.resources } });
      await User.deleteMany({ _id: { $in: cleanup.users } });
    });
  });

});
