import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const contactSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    relationship: { type: String, trim: true, default: '' },
    notifySms: { type: Boolean, default: true },
    notifyWhatsApp: { type: Boolean, default: false },
    notifyEmail: { type: String, trim: true, default: '' },
    isVerified: { type: Boolean, default: false },
  },
  { _id: true }
);

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please provide a name'],
      trim: true,
      maxlength: [100, 'Name cannot exceed 100 characters'],
    },
    email: {
      type: String,
      required: [true, 'Please provide an email'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [
        /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
        'Please provide a valid email address',
      ],
    },
    phone: {
      type: String,
      required: [true, 'Please provide a contact phone number'],
      trim: true,
    },
    passwordHash: {
      type: String,
      required: [true, 'Password hash is required'],
      select: false,
    },
    role: {
      type: String,
      enum: {
        values: ['citizen', 'admin', 'responder', 'hospital', 'volunteer'],
        message: '{VALUE} is not a valid user role',
      },
      default: 'citizen',
    },
    // Primary trusted contact (legacy single contact support)
    emergencyContact: {
      name: { type: String, default: '' },
      phone: { type: String, default: '' },
      relationship: { type: String, default: '' },
    },
    // Personal Emergency Network: Multiple trusted contacts
    emergencyContacts: {
      type: [contactSchema],
      default: [],
    },
    // Consent-based secure location sharing settings
    locationSharingConsent: {
      type: Boolean,
      default: true,
    },
    locationSharingDurationMinutes: {
      type: Number,
      default: 120, // 2-hour secure window by default
      min: 15,
      max: 1440,
    },
    isDemo: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Method to verify password
userSchema.methods.comparePassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.passwordHash);
};

// Static helper to hash passwords
userSchema.statics.hashPassword = async function (password) {
  const salt = await bcrypt.genSalt(10);
  return await bcrypt.hash(password, salt);
};

const User = mongoose.model('User', userSchema);
export default User;
