import mongoose from 'mongoose';
const bloodBankSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', default: null },
  address: { type: String, required: true, trim: true },
  phone: { type: String, required: true, trim: true },
  location: { latitude: { type: Number, required: true, min: -90, max: 90 }, longitude: { type: Number, required: true, min: -180, max: 180 } },
  hours: { type: String, default: 'Call to confirm' },
  inventory: [{ bloodGroup: { type: String, enum: ['A+','A-','B+','B-','AB+','AB-','O+','O-'], required: true }, units: { type: Number, min: 0, default: 0 }, lastUpdatedAt: { type: Date, default: Date.now } }],
  verified: { type: Boolean, default: false },
  isDemo: { type: Boolean, default: false },
}, { timestamps: true });
bloodBankSchema.index({ location: '2dsphere' });
export default mongoose.model('BloodBank', bloodBankSchema);
