import mongoose from 'mongoose';

let isConnected = false;

export const connectDB = async () => {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/emergency360';
  try {
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
    });
    isConnected = true;
    console.log(`[MongoDB] Connected successfully to host: ${conn.connection.host}`);
    return conn;
  } catch (error) {
    isConnected = false;
    console.error(`[MongoDB Error] Failed to connect to MongoDB: ${error.message}`);
    console.warn(
      `[MongoDB Warning] Please ensure MongoDB is running locally or supply a valid MONGODB_URI in backend/.env.\n` +
      `For local testing, start MongoDB service or run: docker run -d -p 27017:27017 --name mongo mongo:7`
    );
    // Don't kill process immediately in development so health check and diagnostics can report status
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }
};

export const isDbConnected = () => isConnected && mongoose.connection.readyState === 1;

export default connectDB;
