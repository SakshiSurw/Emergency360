import express from 'express';
import {
  getManagedAccounts,
  createAdminAccount,
  createResponderAccount,
  createHospitalAccount,
  toggleAccountStatus,
  deleteManagedAccount,
} from '../controllers/adminAccountController.js';
import { protect } from '../middleware/authMiddleware.js';
import { authorize } from '../middleware/roleMiddleware.js';

const router = express.Router();

// All account management routes are strictly reserved for authorized admins
router.use(protect, authorize('admin'));

router.get('/', getManagedAccounts);
router.post('/admin', createAdminAccount);
router.post('/responder', createResponderAccount);
router.post('/hospital', createHospitalAccount);
router.patch('/:id/status', toggleAccountStatus);
router.delete('/:id', deleteManagedAccount);

export default router;
