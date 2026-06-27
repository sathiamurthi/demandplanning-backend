import jwt, { SignOptions } from 'jsonwebtoken';

const JWT_SECRET = (process.env.JWT_SECRET || 'dev-secret-change-this');

export function signJwt(payload: object, expiresIn: string | number = '8h'): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn } as SignOptions);
}

export function verifyJwt(token: string): any {
  return jwt.verify(token, JWT_SECRET);
}
