import mongoose from 'mongoose';
import User from '../models/User.js';
import Responder from '../models/Responder.js';
import Hospital from '../models/Hospital.js';

// @desc    Get all managed operational accounts (Admin, Responder, Hospital)
// @route   GET /api/admin/accounts
// @access  Private (Admin)
export const getManagedAccounts = async (req, res) => {
  try {
    const { role, search, status } = req.query;
    const filter = { isDemo: { $ne: true } };

    if (role && ['admin', 'responder', 'hospital', 'citizen'].includes(role)) {
      filter.role = role;
    } else if (!role || role === 'all') {
      // Default to non-citizen operational staff
      filter.role = { $in: ['admin', 'responder', 'hospital'] };
    }

    if (status === 'active') {
      filter.isActive = { $ne: false };
    } else if (status === 'inactive') {
      filter.isActive = false;
    }

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      filter.$or = [{ name: regex }, { email: regex }, { phone: regex }];
    }

    const users = await User.find(filter)
      .select('-passwordHash')
      .sort({ createdAt: -1 });

    // Attach responder and hospital profiles
    const accounts = await Promise.all(
      users.map(async (u) => {
        const doc = u.toObject();
        if (u.role === 'responder') {
          doc.responderProfile = await Responder.findOne({ userId: u._id, isDemo: { $ne: true } });
        } else if (u.role === 'hospital') {
          doc.hospitalProfile = await Hospital.findOne({ userId: u._id, isDemo: { $ne: true } });
        }
        return doc;
      })
    );

    res.json({
      success: true,
      count: accounts.length,
      data: accounts,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create a new authorized administrator
// @route   POST /api/admin/accounts/admin
// @access  Private (Admin)
export const createAdminAccount = async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    if (!name || !email || !phone || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields (name, email, phone, password)',
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters long',
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'An account with this email address already exists',
      });
    }

    const passwordHash = await User.hashPassword(password);
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      phone: phone.trim(),
      passwordHash,
      role: 'admin',
      isActive: true,
      isDemo: false,
    });

    res.status(201).json({
      success: true,
      message: `Admin account for ${user.name} created successfully. They can now sign in at the Emergency Operations Center portal.`,
      data: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create a new authorized first responder account & vehicle profile
// @route   POST /api/admin/accounts/responder
// @access  Private (Admin)
export const createResponderAccount = async (req, res) => {
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

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'An account with this email address already exists',
      });
    }

    const passwordHash = await User.hashPassword(password);
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      phone: phone.trim(),
      passwordHash,
      role: 'responder',
      isActive: true,
      isDemo: false,
    });

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
      unitName: unitName.trim(),
      vehicleNumber: vehicleNumber ? vehicleNumber.trim() : '',
      badgeNumber: badgeNumber ? badgeNumber.trim() : '',
      availability: 'available',
      currentLocation: {
        latitude: validCoords ? lat : 19.8762,
        longitude: validCoords ? lng : 75.3433,
        address: address ? address.trim() : 'Base Station',
      },
      isDemo: false,
    });

    res.status(201).json({
      success: true,
      message: `Responder account for ${user.name} (${unitName}) created successfully. They can now sign in at the First Responder Mission Hub.`,
      data: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isActive: user.isActive,
        responderProfile: responder,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
        },
        responder,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create a new authorized hospital staff account & facility
// @route   POST /api/admin/accounts/hospital
// @access  Private (Admin)
export const createHospitalAccount = async (req, res) => {
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
      existingHospitalId,
      allowReassign = false,
      confirmReassign = false,
    } = req.body;

    const effectiveStaffName = String(staffName || name || '').trim();
    const effectiveHospitalPhone = String(hospitalPhone || contactPhone || phone || '').trim();

    if (!effectiveStaffName || !email || !phone || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide staff name, email, phone, and password',
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters long',
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'An account with this email address already exists',
      });
    }

    // Safety checks for existing hospital facility before creating any user
    let existingHospital = null;
    if (existingHospitalId) {
      if (!mongoose.Types.ObjectId.isValid(existingHospitalId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid hospital facility ID format',
        });
      }

      existingHospital = await Hospital.findOne({ _id: existingHospitalId, isDemo: { $ne: true } });
      if (!existingHospital) {
        return res.status(404).json({
          success: false,
          message: 'Existing hospital facility not found',
        });
      }

      // Safeguard against unintentional facility reassignment
      if (existingHospital.userId) {
        const currentOwner = await User.findById(existingHospital.userId);
        if (currentOwner && currentOwner.isActive !== false) {
          const isExplicitlyAuthorized = Boolean(allowReassign || confirmReassign);
          if (!isExplicitlyAuthorized) {
            return res.status(409).json({
              success: false,
              message: `Facility "${existingHospital.name}" is already assigned to active staff account (${currentOwner.email}). Reassigning an existing facility requires explicit administrator confirmation (allowReassign: true).`,
            });
          }
        }
      }
    } else {
      if (!hospitalName || !address) {
        return res.status(400).json({
          success: false,
          message: 'Hospital facility name and address are required when creating a new hospital record',
        });
      }
    }

    // Now safely create user account
    const passwordHash = await User.hashPassword(password);
    const user = await User.create({
      name: effectiveStaffName,
      email: normalizedEmail,
      phone: phone.trim(),
      passwordHash,
      role: 'hospital',
      isActive: true,
      isDemo: false,
    });

    let hospitalFacility = null;

    if (existingHospitalId) {
      existingHospital.userId = user._id;
      existingHospital.verifiedAt = existingHospital.verifiedAt || new Date();
      existingHospital.lastUpdatedBy = req.user._id;
      await existingHospital.save();
      hospitalFacility = existingHospital;
    } else {
      const lat = Number(latitude);
      const lng = Number(longitude);
      const validCoords =
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        lat >= -90 &&
        lat <= 90 &&
        lng >= -180 &&
        lng <= 180;

      hospitalFacility = await Hospital.create({
        name: hospitalName.trim(),
        address: address.trim(),
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
        verifiedAt: new Date(),
        lastUpdatedBy: req.user._id,
        isDemo: false,
      });
    }

    res.status(201).json({
      success: true,
      message: `Hospital staff account for ${user.name} linked to ${hospitalFacility.name} created successfully. They can now sign in at the Hospital Operations Portal.`,
      data: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isActive: user.isActive,
        hospitalProfile: hospitalFacility,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
        },
        hospital: hospitalFacility,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Toggle account activation status (Enable/Disable)
// @route   PATCH /api/admin/accounts/:id/status
// @access  Private (Admin)
export const toggleAccountStatus = async (req, res) => {
  try {
    const targetId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(targetId)) {
      return res.status(400).json({ success: false, message: 'Invalid account ID format' });
    }

    if (targetId.toString() === req.user._id.toString()) {
      return res.status(400).json({
        success: false,
        message: 'Cannot deactivate your own active administrator account',
      });
    }

    const user = await User.findById(targetId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    user.isActive = user.isActive === false ? true : false;
    await user.save();

    // If activating an operational staff account, synchronize related status
    if (user.isActive && user.role === 'hospital') {
      await Hospital.updateMany(
        { userId: user._id, verifiedAt: null },
        { $set: { verifiedAt: new Date(), lastUpdatedBy: req.user._id } }
      );
    } else if (user.isActive && user.role === 'responder') {
      await Responder.updateMany(
        { userId: user._id, availability: 'off_duty' },
        { $set: { availability: 'available' } }
      );
    }

    res.json({
      success: true,
      message: `Account for ${user.name} is now ${user.isActive ? 'ACTIVE' : 'DEACTIVATED'}`,
      data: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Delete a managed account and detach associated records
// @route   DELETE /api/admin/accounts/:id
// @access  Private (Admin)
export const deleteManagedAccount = async (req, res) => {
  try {
    const targetId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(targetId)) {
      return res.status(400).json({ success: false, message: 'Invalid account ID format' });
    }

    if (targetId.toString() === req.user._id.toString()) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete your own logged-in administrator account',
      });
    }

    const user = await User.findById(targetId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Account not found' });
    }

    // Cascade detach
    if (user.role === 'responder') {
      await Responder.deleteOne({ userId: user._id });
    } else if (user.role === 'hospital') {
      await Hospital.updateMany({ userId: user._id }, { $set: { userId: null } });
    }

    await User.findByIdAndDelete(targetId);

    res.json({
      success: true,
      message: `Account ${user.email} (${user.role.toUpperCase()}) was deleted successfully`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
