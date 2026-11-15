import express from 'express';
import { body } from 'express-validator';
import {
  register,
  registerResponder,
  registerHospital,
  login,
  getMe,
  updateEmergencyContact,
  getEmergencyNetwork,
  updateEmergencyNetwork,
  logout,
} from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';
import { validateRequest } from '../middleware/validateRequest.js';

const router = express.Router();

// Citizen public registration
router.post(
  '/register',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('phone').trim().notEmpty().withMessage('Phone is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  validateRequest,
  register
);

// First Responder public registration (requires admin approval)
router.post(
  '/register-responder',
  [
    body('name').trim().notEmpty().withMessage('Officer / Medic name is required'),
    body('email').isEmail().withMessage('Valid email address is required'),
    body('phone').trim().notEmpty().withMessage('Contact phone number is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('serviceType').isIn(['medical', 'police', 'fire']).withMessage('Service type must be medical, police, or fire'),
    body('unitName').trim().notEmpty().withMessage('Unit callsign or name is required'),
  ],
  validateRequest,
  registerResponder
);

// Hospital facility public registration (requires admin verification)
router.post(
  '/register-hospital',
  [
    body('email').isEmail().withMessage('Valid email address is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('phone').trim().notEmpty().withMessage('Contact phone number is required'),
    body('hospitalName').trim().notEmpty().withMessage('Hospital facility name is required'),
    body('address').trim().notEmpty().withMessage('Hospital address is required'),
  ],
  validateRequest,
  registerHospital
);

// Authentication
router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  validateRequest,
  login
);

router.get('/me', protect, getMe);
router.patch('/emergency-contact', protect, updateEmergencyContact);
router.get('/emergency-network', protect, getEmergencyNetwork);
router.patch('/emergency-network', protect, updateEmergencyNetwork);
router.post('/logout', protect, logout);

export default router;
