export const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret || secret.length < 32 || /^emergency360_super_secret_jwt_key_/i.test(secret)) {
    throw new Error('JWT_SECRET must be configured with at least 32 random characters.');
  }
  return secret;
};
