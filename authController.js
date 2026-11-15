import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Responder from '../models/Responder.js';
import Hospital from '../models/Hospital.js';
import { getJwtSecret } from '../config/security.js';

const generateToken = (id) => {
  return jwt.sign(
    { id },
    getJwtSecret(),
    { expiresIn: '30d' }
  );
};

// @desc    Register a new citizen
// @route   POST /api/auth/register
// @access  Public
export const register = async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      password,
      emergencyContact,
      emergencyContacts,
      locationSharingConsent = true,
      locationSharingDurationMinutes = 120,
    } = req.body;

    if (!name || !email || !phone || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields (name, email, phone, password)',
      });
    }

    const emergencyPhone = String(emergencyContact?.phone || '').trim();
    if (emergencyPhone && !/^\+[1-9]\d{7,14}$/.test(emergencyPhone)) {
      return res.status(400).json({ success: false, message: 'Trusted contact phone must use international format, for example +14155552671' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'A user with this email already exists',
      });
    }

    const passwordHash = await User.hashPassword(password);

    // Build contacts list
    let contactsList = Array.isArray(emergencyContacts) ? emergencyContacts : [];
    if (contactsList.length === 0 && emergencyContact?.phone) {
      contactsList = [emergencyContact];
    }

    // Public registration defaults to citizen role for security
    const user = await User.create({
      name: String(name).trim(),
      email: normalizedEmail,
      phone: String(phone).trim(),
      passwordHash,
      role: 'citizen',
      isDemo: false,
      emergencyContact: emergencyContact || (contactsList[0] || {}),
      emergencyContacts: contactsList,
      locationSharingConsent: Boolean(locationSharingConsent),
      locationSharingDurationMinutes: Number(locationSharingDurationMinutes) || 120,
      isActive: true,
    });

    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        emergencyContact: user.emergencyContact,
        emergencyContacts: user.emergencyContacts,
        locationSharingConsent: user.locationSharingConsent,
        locationSharingDurationMinutes: user.locationSharingDurationMinutes,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Register a new First Responder (Pending Administrator Approval)
// @route   POST /api/auth/register-responder
// @access  Public
export const registerResponder = async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      password,
      serviceType,
      unitName,
      vehicleNumber,
      badgeNumber,
      latitude,
      longitude,
      address,
    } = req.body;

    if (!name || !email || !phone || !password || !serviceType || !unitName) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields (name, email, phone, password, serviceType, unitName)',
      });
    }

    if (!['medical', 'police', 'fire'].includes(serviceType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid service type. Must be medical, police, or fire.',
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters long',
      });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'An account with this email address already exists',
      });
    }

    const passwordHash = await User.hashPassword(password);
    // Responder created in pending review state (isActive: false)
    const user = await User.create({
      name: String(name).trim(),
      email: normalizedEmail,
      phone: String(phone).trim(),
      passwordHash,
      role: 'responder',
      isActive: false, // Pending admin approval
      isDemo: false,
    });

    try {
      const lat = Number(latitude);
      const lng = Number(longitude);
      const validCoords =
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        lat >= -90 &&
        lat <= 90 &&
        lng >= -180 &&
        lng <= 180;

      const responder = await Responder.create({
        userId: user._id,
        serviceType,
        unitName: String(unitName).trim(),
        vehicleNumber: vehicleNumber ? String(vehicleNumber).trim() : '',
        badgeNumber: badgeNumber ? String(badgeNumber).trim() : '',
        availability: 'off_duty', // Initial status is off_duty until approved
        currentLocation: {
          latitude: validCoords ? lat : 19.8762,
          longitude: validCoords ? lng : 75.3433,
          address: address ? String(address).trim() : 'Base Station',
        },
        isDemo: false,
      });

      res.status(201).json({
        success: true,
        message: `Responder unit registration for ${user.name} (${unitName}) submitted successfully. Your account is pending administrator verification and approval before you can access the Mission Hub.`,
        data: {
          id: user._id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
          isActive: user.isActive,
          responderProfile: responder,
        },
      });
    } catch (profileErr) {
      // Rollback user if responder creation fails
      await User.findByIdAndDelete(user._id);
      throw profileErr;
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Register a new Hospital Facility and staff administrator (Pending Administrator Verification)
// @route   POST /api/auth/register-hospital
// @access  Public
export const registerHospital = async (req, res) => {
  try {
    const {
      staffName,
      name,
      email,
      phone,
      password,
      hospitalName,
      address,
      hospitalPhone,
      contactPhone,
      latitude,
      longitude,
      availableBeds = 10,
      totalBeds = 20,
      availableICUBeds = 2,
      totalICUBeds = 5,
      emergencyAvailable = true,
      services,
      bloodBankAvailable = false,
    } = req.body;

    const effectiveStaffName = String(staffName || name || '').trim();
    const effectiveHospitalPhone = String(hospitalPhone || contactPhone || phone || '').trim();

    if (!effectiveStaffName || !email || !phone || !password || !hospitalName || !address) {
      return res.status(400).json({
        success: false,
        message: 'Please provide staff name, email, phone, password, hospital name, and facility address',
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters long',
      });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'An account with this email address already exists',
      });
    }

    const passwordHash = await User.hashPassword(password);
    // Hospital staff created in pending approval state (isActive: false)
    const user = await User.create({
      name: effectiveStaffName,
      email: normalizedEmail,
      phone: String(phone).trim(),
      passwordHash,
      role: 'hospital',
      isActive: false, // Pending admin approval
      isDemo: false,
    });

    try {
      const lat = Number(latitude);
      const lng = Number(longitude);
      const validCoords =
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        lat >= -90 &&
        lat <= 90 &&
        lng >= -180 &&
        lng <= 180;

      const hospitalFacility = await Hospital.create({
        name: String(hospitalName).trim(),
        address: String(address).trim(),
        phone: effectiveHospitalPhone,
        location: {
          latitude: validCoords ? lat : 19.8762,
          longitude: validCoords ? lng : 75.3433,
        },
        services: Array.isArray(services) && services.length > 0 ? services : ['Emergency', 'Trauma', 'ICU'],
        emergencyAvailable: Boolean(emergencyAvailable),
        availableBeds: Math.max(0, Number(availableBeds)),
        totalBeds: Math.max(1, Number(totalBeds)),
        availableICUBeds: Math.max(0, Number(availableICUBeds)),
        totalICUBeds: Math.max(1, Number(totalICUBeds)),
        bloodBankAvailable: Boolean(bloodBankAvailable),
        userId: user._id,
        verifiedAt: null, // Pending facility verification by EOC Admin
        isDemo: false,
      });

      res.status(201).json({
        success: true,
        message: `Hospital registration for ${hospitalFacility.name} submitted successfully. Your facility record and staff account are pending administrator verification before you can access the Hospital Operations Portal.`,
        data: {
          id: user._id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
          isActive: user.isActive,
          hospitalProfile: hospitalFacility,
        },
      });
    } catch (profileErr) {
      // Rollback user if hospital creation fails
      await User.findByIdAndDelete(user._id);
      throw profileErr;
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Authenticate user & get token
// @route   POST /api/auth/login
// @access  Public
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide both email and password',
      });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail }).select('+passwordHash');
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password credentials',
      });
    }

    if (user.isActive === false) {
      let deactMsg = 'Your account has been deactivated by the system administrator. Please contact your administrator for assistance.';
      if (user.role === 'responder') {
        deactMsg = 'Your responder unit account is pending administrator verification. Please wait for an Emergency Operations Center administrator to review and activate your account.';
      } else if (user.role === 'hospital') {
        deactMsg = 'Your hospital facility registration is pending administrator verification. Please wait for an Emergency Operations Center administrator to review and activate your account.';
      }
      return res.status(403).json({ success: false, message: deactMsg });
    }

    if (user.isDemo === true) {
      return res.status(403).json({ success: false, message: 'Demo accounts are disabled. Register a real account or contact your administrator.' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password credentials',
      });
    }

    const token = generateToken(user._id);

    // If responder or hospital, attach profile details
    let responderProfile = null;
    if (user.role === 'responder') {
      responderProfile = await Responder.findOne({ userId: user._id });
    }
    let hospitalProfile = null;
    if (user.role === 'hospital') {
      hospitalProfile = await Hospital.findOne({ userId: user._id });
    }

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        emergencyContact: user.emergencyContact,
        emergencyContacts: user.emergencyContacts || [],
        locationSharingConsent: user.locationSharingConsent,
        locationSharingDurationMinutes: user.locationSharingDurationMinutes,
        responderProfile,
        hospitalProfile,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get current logged in user
// @route   GET /api/auth/me
// @access  Private
export const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    let responderProfile = null;
    if (user.role === 'responder') {
      responderProfile = await Responder.findOne({ userId: user._id });
    }
    let hospitalProfile = null;
    if (user.role === 'hospital') {
      hospitalProfile = await Hospital.findOne({ userId: user._id });
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        emergencyContact: user.emergencyContact,
        emergencyContacts: user.emergencyContacts || [],
        locationSharingConsent: user.locationSharingConsent,
        locationSharingDurationMinutes: user.locationSharingDurationMinutes,
        responderProfile,
        hospitalProfile,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update the authenticated citizen's trusted SOS contact (legacy single contact)
// @route   PATCH /api/auth/emergency-contact
// @access  Private (Citizen)
export const updateEmergencyContact = async (req, res) => {
  try {
    const { name = '', phone = '', relationship = '' } = req.body;
    const normalizedPhone = String(phone).trim();
    if (normalizedPhone && !/^\+[1-9]\d{7,14}$/.test(normalizedPhone)) {
      return res.status(400).json({ success: false, message: 'Trusted contact phone must use international format, for example +14155552671' });
    }
    const singleContact = { name: String(name).trim(), phone: normalizedPhone, relationship: String(relationship).trim() };

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    user.emergencyContact = singleContact;
    if (normalizedPhone) {
      // Ensure it is in the contacts array
      if (!Array.isArray(user.emergencyContacts) || user.emergencyContacts.length === 0) {
        user.emergencyContacts = [singleContact];
      } else {
        user.emergencyContacts[0] = { ...user.emergencyContacts[0], ...singleContact };
      }
    }
    await user.save();

    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        emergencyContact: user.emergencyContact,
        emergencyContacts: user.emergencyContacts,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get Personal Emergency Network (trusted contacts and location sharing consent)
// @route   GET /api/auth/emergency-network
// @access  Private (Citizen, Admin)
export const getEmergencyNetwork = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const contacts = Array.isArray(user.emergencyContacts) && user.emergencyContacts.length > 0
      ? user.emergencyContacts
      : user.emergencyContact?.phone
      ? [user.emergencyContact]
      : [];

    res.json({
      success: true,
      data: {
        emergencyContacts: contacts,
        locationSharingConsent: user.locationSharingConsent !== false,
        locationSharingDurationMinutes: user.locationSharingDurationMinutes || 120,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update Personal Emergency Network (multiple contacts, channels, consent)
// @route   PATCH /api/auth/emergency-network
// @access  Private (Citizen, Admin)
export const updateEmergencyNetwork = async (req, res) => {
  try {
    const { emergencyContacts, locationSharingConsent, locationSharingDurationMinutes } = req.body;

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (Array.isArray(emergencyContacts)) {
      for (const c of emergencyContacts) {
        const p = String(c.phone || '').trim();
        if (p && !/^\+[1-9]\d{7,14}$/.test(p)) {
          return res.status(400).json({
            success: false,
            message: `Contact "${c.name || 'unnamed'}" phone number must use international format (e.g. +14155552671)`,
          });
        }
      }

      user.emergencyContacts = emergencyContacts.map((c) => ({
        name: String(c.name || '').trim(),
        phone: String(c.phone || '').trim(),
        relationship: String(c.relationship || '').trim(),
        notifySms: c.notifySms !== false,
        notifyWhatsApp: Boolean(c.notifyWhatsApp),
        notifyEmail: String(c.notifyEmail || '').trim(),
        isVerified: Boolean(c.isVerified),
      }));

      // Synchronize primary contact with first contact in list for backward compatibility
      if (user.emergencyContacts.length > 0) {
        user.emergencyContact = {
          name: user.emergencyContacts[0].name,
          phone: user.emergencyContacts[0].phone,
          relationship: user.emergencyContacts[0].relationship,
        };
      }
    }

    if (locationSharingConsent !== undefined) {
      user.locationSharingConsent = Boolean(locationSharingConsent);
    }

    if (locationSharingDurationMinutes !== undefined) {
      user.locationSharingDurationMinutes = Math.min(1440, Math.max(15, Number(locationSharingDurationMinutes)));
    }

    await user.save();

    res.json({
      success: true,
      message: 'Personal Emergency Network settings updated successfully',
      data: {
        emergencyContacts: user.emergencyContacts,
        emergencyContact: user.emergencyContact,
        locationSharingConsent: user.locationSharingConsent,
        locationSharingDurationMinutes: user.locationSharingDurationMinutes,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Logout user / clear session
// @route   POST /api/auth/logout
// @access  Private
export const logout = async (req, res) => {
  res.json({
    success: true,
    message: 'User logged out successfully',
  });
};
