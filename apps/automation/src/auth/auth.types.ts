export interface JwtPayload {
  sub: number;
  username?: string;
  firstName: string;
}

export interface AuthenticatedRequest {
  user?: JwtPayload;
}
