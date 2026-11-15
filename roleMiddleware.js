/**
 * Restrict endpoint access to specific user roles
 * @param  {...string} roles - e.g. 'admin', 'responder', 'citizen', 'hospital'
 */
export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required prior to authorization check',
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Role forbidden: Your role (${req.user.role}) is not authorized to perform this action`,
      });
    }

    next();
  };
};
