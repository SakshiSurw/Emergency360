import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import User from '../models/User.js';
import Responder from '../models/Responder.js';
import Hospital from '../models/Hospital.js';
import Incident from '../models/Incident.js';
import Notification from '../models/Notification.js';

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/emergency360';
try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 7000 });
  // Ensure model collections and declared indexes exist without deleting existing records.
  const models = [User, Responder, Hospital, Incident, Notification];
  for (const model of models) await model.createCollection().catch((err) => {
    if (err.codeName !== 'NamespaceExists' && err.code !== 48) throw err;
  });
  for (const model of models) {
    const count = await model.countDocuments();
    console.log(`${model.collection.collectionName}: ${count} record(s)`);
  }
  console.log(`Database check passed: ${mongoose.connection.name} @ ${mongoose.connection.host}`);
} catch (error) {
  console.error(`Database check failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
