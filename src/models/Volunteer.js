import mongoose from 'mongoose';

const volunteerSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    organizationName: {
      type: String,
      required: [true, 'Organization or volunteer unit name is required'],
      trim: true,
    },
    type: {
      type: String,
      enum: ['individual', 'ngo'],
      default: 'individual',
    },
    serviceAreas: {
      type: [String],
      default: [],
    },
    skills: {
      type: [String],
      enum: [
        'boat_rescue',
        'medical_first_aid',
        'food_water_distribution',
        'heavy_transport',
        'shelter_management',
        'general_relief',
      ],
      default: ['general_relief'],
    },
    capacity: {
      volunteersCount: { type: Number, default: 1, min: 1 },
      boatsCount: { type: Number, default: 0, min: 0 },
      vehiclesCount: { type: Number, default: 0, min: 0 },
      maxBeneficiariesPerDay: { type: Number, default: 50, min: 0 },
    },
    availability: {
      type: String,
      enum: ['available', 'deployed', 'unavailable'],
      default: 'available',
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    isDemo: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

volunteerSchema.index({ status: 1, availability: 1 });
volunteerSchema.index({ serviceAreas: 1, status: 1 });

const Volunteer = mongoose.model('Volunteer', volunteerSchema);
export default Volunteer;
