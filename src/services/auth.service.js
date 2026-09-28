import { prisma } from '../config/database.js';
import { ConflictError, UnauthorizedError, isUniqueConstraintError } from '../utils/errors.js';
import { hashPassword, verifyAgainstDummyHash, verifyPassword } from '../utils/password.js';

// The only user fields that ever leave the service. passwordHash never does.
const publicUserFields = { id: true, email: true, createdAt: true };

// Same message for "no such email" and "wrong password". Different messages
// would let an attacker find out which emails have accounts (user enumeration).
const INVALID_CREDENTIALS = 'Invalid email or password';

export async function registerUser({ email, password }) {
  const passwordHash = await hashPassword(password);

  try {
    return await prisma.user.create({
      data: { email, passwordHash },
      select: publicUserFields,
    });
  } catch (err) {
    // No "SELECT first to check if the email is taken": two simultaneous
    // sign-ups could both pass that check. The unique index on email is atomic,
    // so we just try the insert and translate the violation into a 409.
    if (isUniqueConstraintError(err)) {
      throw new ConflictError('An account with this email already exists');
    }
    throw err;
  }
}

export async function authenticateUser({ email, password }) {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    // Burn the same ~30 ms as a real password check, so a fast response
    // doesn't reveal that the email isn't registered.
    await verifyAgainstDummyHash(password);
    throw new UnauthorizedError(INVALID_CREDENTIALS);
  }

  if (!(await verifyPassword(user.passwordHash, password))) {
    throw new UnauthorizedError(INVALID_CREDENTIALS);
  }

  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

export function getUserById(id) {
  return prisma.user.findUnique({ where: { id }, select: publicUserFields });
}
