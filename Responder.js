import mongoose from 'mongoose';

const responderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    serviceType: {
      type: String,
      enum: ['medical', 'police', 'fire'],
      required: [true, 'Service type is required (medical, police, fire)'],
    },
    unitName: {
      type: String,
      required: [true, 'Unit name is required (e.g. Unit 101)'],
      trim: true,
    },
    vehicleNumber: {
      type: String,
      trim: true,
      default: '',
    },
    badgeNumber: {
      type: String,
      trim: true,
      default: '',
    },
    availability: {
      type: String,
      enum: ['available', 'busy', 'off_duty'],
      default: 'available',
    },
    currentLocation: {
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
      address: {
        type: String,
        default: 'Location tracked',
      },
    },
    assignedIncidentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Incident',
      default: null,
    },
    lastLocationUpdate: {
      type: Date,
      default: Date.now,
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

// Indexes for geospatial distance queries and status filtering
responderSchema.index({ availability: 1, serviceType: 1 });

const Responder = mongoose.model('Responder', responderSchema);
export default Responder;
