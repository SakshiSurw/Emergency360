import mongoose from 'mongoose';

const hospitalSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Hospital name is required'],
      trim: true,
    },
    address: {
      type: String,
      required: [true, 'Hospital address is required'],
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
      default: '',
    },
    location: {
      latitude: {
        type: Number,
        required: true,
        min: -90,
        max: 90,
      },
      longitude: {
        type: Number,
        required: true,
        min: -180,
        max: 180,
      },
    },
    services: { type: [String], default: [] },
    professionals: { type: [{ name: String, profession: String, department: String, phone: String, available: { type: Boolean, default: true } }], default: [] },
    bloodBankAvailable: { type: Boolean, default: false },
    bloodBankId: { type: mongoose.Schema.Types.ObjectId, ref: 'BloodBank', default: null },
    verifiedAt: { type: Date, default: null },
    emergencyAvailable: {
      type: Boolean,
      default: false,
    },
    availableBeds: {
      type: Number,
      required: true,
      min: [0, 'Available beds cannot be negative'],
      default: 0,
    },
    totalBeds: {
      type: Number,
      required: true,
      min: [0, 'Total beds cannot be negative'],
      default: 0,
    },
    availableICUBeds: {
      type: Number,
      required: true,
      min: [0, 'Available ICU beds cannot be negative'],
      default: 0,
    },
    totalICUBeds: {
      type: Number,
      required: true,
      min: [0, 'Total ICU beds cannot be negative'],
      default: 0,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    lastUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    isDemo: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Validation: availableBeds cannot exceed totalBeds
hospitalSchema.pre('save', function (next) {
  if (this.availableBeds > this.totalBeds) {
    this.availableBeds = this.totalBeds;
  }
  if (this.availableICUBeds > this.totalICUBeds) {
    this.availableICUBeds = this.totalICUBeds;
  }
  next();
});

const Hospital = mongoose.model('Hospital', hospitalSchema);
export default Hospital;
