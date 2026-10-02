import { prisma } from '../config/database.js';
import { ConflictError, UnauthorizedError, isUniqueViolation } from '../utils/errors.js';
import { hashPassword, verifyPassword } from '../utils/password.js';

// The only user fields ever returned. passwordHash never leaves this file.
const publicFields = { id: true, email: true, createdAt: true };

export async function registerUser({ email, password }) {
  try {
    return await prisma.user.create({
      data: { email, passwordHash: await hashPassword(password) },
      select: publicFields,
    });
  } catch (err) {
    // The unique index on email decides, even if two sign-ups arrive at the same moment.
    if (isUniqueViolation(err)) throw ConflictError('An account with this email already exists');
    throw err;
  }
}

export async function loginUser({ email, password }) {
  const user = await prisma.user.findUnique({ where: { email } });
  // Same message for "no such email" and "wrong password", so attackers can't
  // find out which emails have accounts.
  if (!user || !(await verifyPassword(user.passwordHash, password))) {
    throw UnauthorizedError('Invalid email or password');
  }
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

export const getUser = (id) => prisma.user.findUnique({ where: { id }, select: publicFields });
